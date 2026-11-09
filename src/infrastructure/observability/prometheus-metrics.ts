import { Counter, Gauge, Histogram, Registry } from 'prom-client';
import type { WagerTransactionStatus } from '../../domain/wager-transaction.ts';
import { Metrics, type DuplicateSource, type LockConflictReason, type RetryKind } from '../../application/ports/metrics.ts';

// One registry per app instance: the test suites run several apps in one process and the default registry is global.
export class PrometheusMetrics extends Metrics {
  readonly registry = new Registry();

  private readonly transactions = new Counter({
    name: 'wager_transactions_total',
    help: 'Wager transactions by the status they reached',
    labelNames: ['status'],
    registers: [this.registry],
  });
  private readonly duplicates = new Counter({
    name: 'duplicates_detected_total',
    help: 'Idempotent replays and inbox redeliveries answered without a new effect',
    labelNames: ['source'],
    registers: [this.registry],
  });
  private readonly retries = new Counter({
    name: 'retries_total',
    help: 'Retried attempts by kind of work',
    labelNames: ['kind'],
    registers: [this.registry],
  });
  private readonly deadLetters = new Counter({
    name: 'dlq_messages_total',
    help: 'Messages sent to the dead-letter queue',
    registers: [this.registry],
  });
  private readonly lockConflicts = new Counter({
    name: 'lock_conflicts_total',
    help: 'Writers that met on the same wallet (lock timeout, deadlock, serialization, version conflict)',
    labelNames: ['reason'],
    registers: [this.registry],
  });
  private readonly divergences = new Counter({
    name: 'reconciliation_divergence_total',
    help: 'Wallets whose balance did not match the ledger sum in a reconciliation',
    registers: [this.registry],
  });
  private readonly processing = new Histogram({
    name: 'processing_duration_seconds',
    help: 'Time to answer a wager transaction submission, replays included',
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [this.registry],
  });

  constructor(outboxLagSeconds: () => Promise<number>) {
    super();
    new Gauge({
      name: 'outbox_lag_seconds',
      help: 'Age of the oldest unpublished outbox event, read from the database at scrape time',
      registers: [this.registry],
      async collect() {
        this.set(await outboxLagSeconds());
      },
    });
  }

  transactionDecided(status: WagerTransactionStatus): void {
    this.transactions.inc({ status });
  }
  duplicateDetected(source: DuplicateSource): void {
    this.duplicates.inc({ source });
  }
  retried(kind: RetryKind): void {
    this.retries.inc({ kind });
  }
  deadLettered(): void {
    this.deadLetters.inc();
  }
  lockConflict(reason: LockConflictReason): void {
    this.lockConflicts.inc({ reason });
  }
  reconciliationDiverged(): void {
    this.divergences.inc();
  }
  processingObserved(seconds: number): void {
    this.processing.observe(seconds);
  }
}
