import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus, type WagerPayload } from '../../domain/wager-transaction.ts';
import type { Wallet } from '../../domain/wallet.ts';
import type { WalletLedgerEntry } from '../../domain/wallet-ledger-entry.ts';
import type { InboxMessage } from '../../domain/inbox-message.ts';
import { FailureCode } from '../../domain/failure-codes.ts';
import { DomainError, InvariantViolationError } from '../../domain/errors/domain-errors.ts';
import type { EventContext, IntegrationEvent } from '../../domain/events/integration-event.ts';
import {
  WagerTransactionPendingReference,
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WalletBalanceChanged,
} from '../../domain/events/wager-events.ts';
import type { Clock } from '../ports/clock.ts';
import type { IdGenerator } from '../ports/id-generator.ts';
import type { Repositories, UnitOfWork } from '../ports/unit-of-work.ts';
import type { Metrics } from '../ports/metrics.ts';
import { logContext } from '../log-context.ts';
import { DuplicateTransactionError, LockConflictError, TransientFailureError } from '../errors.ts';

export interface SubmitWagerCommand {
  idempotencyKey: string;
  payload: WagerPayload;
  correlationId: string;
}

export interface SubmitWagerResult {
  transaction: WagerTransaction;
  idempotentReplay: boolean;
}

/** The single entry point for a provider operation, shared by HTTP and the queue consumer. */
export class SubmitWagerTransaction {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    private readonly metrics: Metrics,
  ) {}

  /** `inbox` joins the same SQL transaction, so a redelivered message and its effect commit or roll back together; on a replay it is recorded alone, and a messageId the inbox already knows throws DuplicateInboxMessageError before anything is counted. */
  async execute(command: SubmitWagerCommand, inbox?: InboxMessage): Promise<SubmitWagerResult> {
    const started = performance.now();
    try {
      const result = await this.submit(command, inbox);
      const { transaction, idempotentReplay } = result;
      logContext.assign({ transactionId: transaction.id, status: transaction.status, failureCode: transaction.failureCode, idempotentReplay });
      if (idempotentReplay) this.metrics.duplicateDetected('idempotency_key');
      else this.metrics.transactionDecided(transaction.status);
      return result;
    } catch (error) {
      if (error instanceof LockConflictError) this.metrics.lockConflict(error.reason);
      throw error;
    } finally {
      this.metrics.processingObserved((performance.now() - started) / 1000);
    }
  }

  private async submit(command: SubmitWagerCommand, inbox: InboxMessage | undefined): Promise<SubmitWagerResult> {
    logContext.assign({ walletId: command.payload.walletId, providerId: command.payload.providerId, kind: command.payload.kind });
    const transaction = WagerTransaction.create({
      ...command.payload,
      id: this.ids.next(),
      idempotencyKey: command.idempotencyKey,
      createdAt: this.clock.now(),
    });

    const known = await this.replay(transaction, inbox);
    if (known) return known;

    try {
      return await this.uow.transaction((repositories) => this.process(repositories, transaction, command, inbox));
    } catch (error) {
      if (!(error instanceof DuplicateTransactionError)) throw error;
      if (error.field === 'externalTransactionId') {
        throw new DomainError(FailureCode.IdempotencyConflict, 'externalTransactionId was already submitted under another Idempotency-Key');
      }
      const winner = await this.replay(transaction, inbox);
      if (!winner) throw new TransientFailureError('idempotency key collided with a transaction that is not visible yet', { cause: error });
      return winner;
    }
  }

  private async replay(candidate: WagerTransaction, inbox: InboxMessage | undefined): Promise<SubmitWagerResult | undefined> {
    const stored = await this.uow.read((r) => r.transactions.findByIdempotencyKey(candidate.idempotencyKey));
    if (!stored) return undefined;
    if (!stored.matchesPayload(candidate.payloadHash)) {
      throw new DomainError(FailureCode.IdempotencyConflict, 'Idempotency-Key was already used with a different payload');
    }
    if (inbox) await this.uow.transaction((r) => r.inbox.add(inbox));
    return { transaction: stored, idempotentReplay: true };
  }

  private async process(
    r: Repositories,
    transaction: WagerTransaction,
    command: SubmitWagerCommand,
    inbox: InboxMessage | undefined,
  ): Promise<SubmitWagerResult> {
    if (inbox) await r.inbox.add(inbox);
    // Insert-first: the unique index on idempotency_key decides a race before anyone touches the wallet.
    await r.transactions.insert(transaction);

    const wallet =
      transaction.kind === WagerTransactionKind.Loss
        ? await r.wallets.findById(transaction.walletId)
        : await r.wallets.lockById(transaction.walletId);
    if (!wallet) throw new InvariantViolationError(`wallet ${transaction.walletId} vanished after its foreign key check`);

    const reference = transaction.referenceExternalTransactionId
      ? await r.transactions.findByExternalId(transaction.providerId, transaction.referenceExternalTransactionId)
      : undefined;
    const referenceAlreadyReversed =
      reference !== undefined && transaction.requiresReference() && (await r.transactions.hasProcessedReversal(reference.id));

    const versionBefore = wallet.version;
    const now = this.clock.now();
    const entry = transaction.applyTo(wallet, { entryId: this.ids.next(), at: now, reference, referenceAlreadyReversed });

    if (entry) {
      await r.ledger.append(entry);
      await r.wallets.save(wallet, versionBefore);
    }
    await r.transactions.save(transaction);
    const context = (): EventContext => ({
      eventId: this.ids.next(),
      correlationId: command.correlationId,
      causationId: inbox?.messageId,
      occurredAt: now,
    });
    await r.outbox.enqueue(eventsFor(transaction, wallet, entry, context));
    return { transaction, idempotentReplay: false };
  }
}

/** Spec section 11: a status event per decided transaction, plus WalletBalanceChanged only when money moved. */
export function eventsFor(
  transaction: WagerTransaction,
  wallet: Wallet,
  entry: WalletLedgerEntry | undefined,
  context: () => EventContext,
): IntegrationEvent<unknown>[] {
  switch (transaction.status) {
    case WagerTransactionStatus.Processed:
      return [
        WagerTransactionProcessed.from(transaction, context()),
        ...(entry ? [WalletBalanceChanged.from(wallet, entry, context())] : []),
      ];
    case WagerTransactionStatus.Rejected:
      return [WagerTransactionRejected.from(transaction, context())];
    case WagerTransactionStatus.PendingReference:
      return [WagerTransactionPendingReference.from(transaction, context())];
    default:
      throw new InvariantViolationError(`transaction ${transaction.id} left processing as ${transaction.status}`);
  }
}
