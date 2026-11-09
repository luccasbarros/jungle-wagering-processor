import {
  DEFAULT_PENDING_REFERENCE_POLICY,
  WagerTransactionStatus,
  type PendingReferencePolicy,
  type WagerTransaction,
} from '../../domain/wager-transaction.ts';
import { FailureCode } from '../../domain/failure-codes.ts';
import { InvariantViolationError } from '../../domain/errors/domain-errors.ts';
import type { EventContext } from '../../domain/events/integration-event.ts';
import type { Clock } from '../ports/clock.ts';
import type { IdGenerator } from '../ports/id-generator.ts';
import type { Repositories, UnitOfWork } from '../ports/unit-of-work.ts';
import type { Metrics } from '../ports/metrics.ts';
import type { LogFields } from '../log-context.ts';
import { LockConflictError, TransientFailureError } from '../errors.ts';
import { eventsFor } from './submit-wager-transaction.ts';

export type PendingReferenceOutcome = 'processed' | 'rejected' | 'retried' | 'failed';

export interface PendingReferenceAttempt {
  /** Identifiers for the log line; correlationId is the transaction id, like the events this worker emits. */
  log: LogFields;
  /** Undefined when the attempt failed and the row could not be backed off either. */
  outcome?: PendingReferenceOutcome;
  /** Error class name only: driver messages carry the SQL parameters, amounts included. */
  error?: string;
}

export interface PendingReferenceRun extends Record<PendingReferenceOutcome, number> {
  /** Transactions whose attempt blew up; each is backed off (or FAILED) in its own transaction. */
  errors: number;
  attempts: PendingReferenceAttempt[];
}

const DECIDED_STATUS: Record<Exclude<PendingReferenceOutcome, 'retried'>, WagerTransactionStatus> = {
  processed: WagerTransactionStatus.Processed,
  rejected: WagerTransactionStatus.Rejected,
  failed: WagerTransactionStatus.Failed,
};

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
    private readonly metrics: Metrics,
    options: ProcessPendingReferencesOptions = {},
  ) {
    this.policy = options.policy ?? DEFAULT_PENDING_REFERENCE_POLICY;
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  }

  /** Safe to run on every instance at once: each claim is a row lock with SKIP LOCKED, held until that row's commit. */
  async runOnce(): Promise<PendingReferenceRun> {
    const run: PendingReferenceRun = { processed: 0, rejected: 0, retried: 0, failed: 0, errors: 0, attempts: [] };
    for (let i = 0; i < this.batchSize; i++) {
      let claimed: WagerTransaction | undefined;
      try {
        const outcome = await this.uow.transaction((r) => this.processNext(r, (transaction) => (claimed = transaction)));
        if (!outcome) break;
        this.record(run, claimed!, outcome);
      } catch (error) {
        run.errors += 1;
        if (error instanceof LockConflictError) this.metrics.lockConflict(error.reason);
        const errorName = error instanceof Error ? error.name : 'UnknownError';
        // Contention or a lost connection: nothing to back off, the row is simply still due next tick.
        if (error instanceof TransientFailureError || claimed === undefined) {
          if (claimed) this.record(run, claimed, undefined, errorName);
          break;
        }
        this.record(run, claimed, await this.backOffAfterError(claimed.id), errorName);
      }
    }
    return run;
  }

  private record(run: PendingReferenceRun, transaction: WagerTransaction, outcome: PendingReferenceOutcome | undefined, error?: string): void {
    run.attempts.push({ log: logFieldsOf(transaction, outcome), outcome, error });
    if (!outcome) return;
    run[outcome] += 1;
    if (outcome === 'retried') {
      this.metrics.retried('pending_reference');
      return;
    }
    this.metrics.transactionDecided(DECIDED_STATUS[outcome]);
    // REFERENCE_NOT_FOUND only comes from the policy giving up; a reference that arrived and broke a rule has another code.
    if (outcome === 'failed' || transaction.failureCode === FailureCode.ReferenceNotFound) {
      this.metrics.pendingReferenceExhausted(DECIDED_STATUS[outcome]);
    }
  }

  private async processNext(r: Repositories, onClaim: (transaction: WagerTransaction) => void): Promise<PendingReferenceOutcome | undefined> {
    const now = this.clock.now();
    const transaction = await r.transactions.claimDuePendingReference(now);
    if (!transaction) return undefined;
    onClaim(transaction);

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

// After a rolled-back attempt the in-memory transaction may say PROCESSED; only a committed decision speaks for itself.
function logFieldsOf(transaction: WagerTransaction, outcome: PendingReferenceOutcome | undefined): LogFields {
  const decided = outcome === 'processed' || outcome === 'rejected';
  const failed = outcome === 'failed';
  return {
    correlationId: transaction.id,
    transactionId: transaction.id,
    walletId: transaction.walletId,
    providerId: transaction.providerId,
    kind: transaction.kind,
    status: decided ? transaction.status : failed ? WagerTransactionStatus.Failed : WagerTransactionStatus.PendingReference,
    failureCode: decided ? transaction.failureCode : failed ? FailureCode.PermanentFailure : undefined,
  };
}
