import {
  DEFAULT_PENDING_REFERENCE_POLICY,
  WagerTransactionStatus,
  type PendingReferencePolicy,
} from '../../domain/wager-transaction.ts';
import { FailureCode } from '../../domain/failure-codes.ts';
import { InvariantViolationError } from '../../domain/errors/domain-errors.ts';
import type { EventContext } from '../../domain/events/integration-event.ts';
import type { Clock } from '../ports/clock.ts';
import type { IdGenerator } from '../ports/id-generator.ts';
import type { Repositories, UnitOfWork } from '../ports/unit-of-work.ts';
import { TransientFailureError } from '../errors.ts';
import { eventsFor } from './submit-wager-transaction.ts';

export type PendingReferenceOutcome = 'processed' | 'rejected' | 'retried' | 'failed';

export interface PendingReferenceRun extends Record<PendingReferenceOutcome, number> {
  /** Transactions whose attempt blew up; each is backed off (or FAILED) in its own transaction. */
  errors: number;
}

export interface ProcessPendingReferencesOptions {
  policy?: PendingReferencePolicy;
  /** Max pending transactions one `runOnce` handles before yielding. */
  batchSize?: number;
}

const DEFAULT_BATCH_SIZE = 20;

/** Spec 7.1: re-resolves PENDING_REFERENCE transactions with backoff; REJECTED REFERENCE_NOT_FOUND when the policy gives up. */
export class ProcessPendingReferences {
  private readonly policy: PendingReferencePolicy;
  private readonly batchSize: number;

  constructor(
    private readonly uow: UnitOfWork,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
    options: ProcessPendingReferencesOptions = {},
  ) {
    this.policy = options.policy ?? DEFAULT_PENDING_REFERENCE_POLICY;
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  }

  /** Safe to run on every instance at once: each claim is a row lock with SKIP LOCKED, held until that row's commit. */
  async runOnce(): Promise<PendingReferenceRun> {
    const run: PendingReferenceRun = { processed: 0, rejected: 0, retried: 0, failed: 0, errors: 0 };
    for (let i = 0; i < this.batchSize; i++) {
      let claimedId: string | undefined;
      try {
        const outcome = await this.uow.transaction((r) => this.processNext(r, (id) => (claimedId = id)));
        if (!outcome) break;
        run[outcome] += 1;
      } catch (error) {
        run.errors += 1;
        // Contention or a lost connection: nothing to back off, the row is simply still due next tick.
        if (error instanceof TransientFailureError || claimedId === undefined) break;
        const outcome = await this.backOffAfterError(claimedId);
        if (outcome) run[outcome] += 1;
      }
    }
    return run;
  }

  private async processNext(r: Repositories, onClaim: (id: string) => void): Promise<PendingReferenceOutcome | undefined> {
    const now = this.clock.now();
    const transaction = await r.transactions.claimDuePendingReference(now);
    if (!transaction) return undefined;
    onClaim(transaction.id);

    const wallet = await r.wallets.lockById(transaction.walletId);
    if (!wallet) throw new InvariantViolationError(`wallet ${transaction.walletId} of pending transaction ${transaction.id} is gone`);
    const reference = await r.transactions.findByExternalId(transaction.providerId, transaction.referenceExternalTransactionId!);
    const referenceAlreadyReversed =
      reference !== undefined && transaction.requiresReference() && (await r.transactions.hasProcessedReversal(reference.id));

    const versionBefore = wallet.version;
    const entry = transaction.applyTo(wallet, { entryId: this.ids.next(), at: now, reference, referenceAlreadyReversed });

    if (transaction.status === WagerTransactionStatus.PendingReference) {
      if (transaction.hasExhaustedRetries(now, this.policy)) {
        transaction.reject(FailureCode.ReferenceNotFound, wallet.balance);
      } else {
        transaction.scheduleRetry(now, this.policy);
        await r.transactions.save(transaction);
        return 'retried';
      }
    }

    if (entry) {
      await r.ledger.append(entry);
      await r.wallets.save(wallet, versionBefore);
    }
    await r.transactions.save(transaction);
    // No request to inherit a correlation from: the transaction itself is the trace.
    const context = (): EventContext => ({ eventId: this.ids.next(), correlationId: transaction.id, occurredAt: now });
    await r.outbox.enqueue(eventsFor(transaction, wallet, entry, context));
    return transaction.status === WagerTransactionStatus.Processed ? 'processed' : 'rejected';
  }

  /** The attempt rolled back on an unexpected error: back the row off so a poison row is not retried every tick, FAILED once exhausted. */
  private async backOffAfterError(id: string): Promise<PendingReferenceOutcome | undefined> {
    try {
      return await this.uow.transaction(async (r) => {
        const transaction = await r.transactions.lockPendingReferenceById(id);
        if (!transaction) return undefined;
        const now = this.clock.now();
        if (transaction.hasExhaustedRetries(now, this.policy)) transaction.fail(FailureCode.PermanentFailure);
        else transaction.scheduleRetry(now, this.policy);
        await r.transactions.save(transaction);
        return transaction.status === WagerTransactionStatus.Failed ? 'failed' : 'retried';
      });
    } catch {
      return undefined;
    }
  }
}
