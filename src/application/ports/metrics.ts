import type { WagerTransactionStatus } from '../../domain/wager-transaction.ts';

export type DuplicateSource = 'http' | 'sqs';
export type RetryKind = 'outbox_publish' | 'pending_reference' | 'message_redelivery';
export type LockConflictReason = 'lock_timeout' | 'serialization' | 'deadlock' | 'version_conflict';

/** Counters every slice reports into; the outbox lag is read from the database at scrape time, not reported. */
export abstract class Metrics {
  /** A transaction reached `status`; a PENDING_REFERENCE that later resolves counts again under its final status. */
  abstract transactionDecided(status: WagerTransactionStatus): void;
  /** An idempotency-key replay (HTTP or queue) or an inbox redelivery acked without effect. */
  abstract duplicateDetected(source: DuplicateSource): void;
  abstract retried(kind: RetryKind): void;
  abstract deadLettered(): void;
  abstract lockConflict(reason: LockConflictReason): void;
  abstract reconciliationDiverged(): void;
  abstract processingObserved(seconds: number): void;
}
