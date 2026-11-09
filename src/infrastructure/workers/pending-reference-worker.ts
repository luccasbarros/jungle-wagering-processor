import { Logger, type Provider } from '@nestjs/common';
import { Clock } from '../../application/ports/clock.ts';
import { IdGenerator } from '../../application/ports/id-generator.ts';
import { UnitOfWork } from '../../application/ports/unit-of-work.ts';
import { Metrics } from '../../application/ports/metrics.ts';
import { logContext } from '../../application/log-context.ts';
import { safeReason, safeStack } from '../../application/errors.ts';
import { ProcessPendingReferences } from '../../application/use-cases/process-pending-references.ts';
import { DEFAULT_PENDING_REFERENCE_POLICY } from '../../domain/wager-transaction.ts';

export const PENDING_REFERENCE_POLL_INTERVAL_ENV = 'PENDING_REFERENCE_POLL_INTERVAL_MS';
const DEFAULT_POLL_INTERVAL_MS = 2_000;

const envInt = (name: string, fallback: number): number => {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? fallback : parseInt(raw, 10);
};

/** Plan 4.6: a timer per instance; ticks never overlap within one instance, instances coordinate through SKIP LOCKED. */
export class PendingReferenceWorker {
  private readonly logger = new Logger(PendingReferenceWorker.name);
  private timer: ReturnType<typeof setInterval> | undefined;
  private inFlight: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(
    private readonly processor: ProcessPendingReferences,
    private readonly intervalMs: number,
  ) {}

  onApplicationBootstrap(): void {
    // 0 disables the timer (tests drive runOnce by hand).
    if (this.intervalMs <= 0) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref?.();
  }

  // before, not on, ApplicationShutdown: Nest runs same-level onApplicationShutdown hooks in parallel with the ORM close.
  async beforeApplicationShutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.inFlight;
  }

  private tick(): Promise<void> {
    this.inFlight = this.inFlight.then(async () => {
      if (this.stopped) return;
      try {
        const { attempts, ...counts } = await this.processor.runOnce();
        for (const { log, outcome, error } of attempts) {
          logContext.run(log, () =>
            error ? this.logger.warn(`pending reference attempt failed (${error}), ${outcome ?? 'left due'}`) : this.logger.log(`pending reference ${outcome}`),
          );
        }
        if (counts.processed || counts.rejected || counts.failed || counts.errors) this.logger.log(JSON.stringify(counts));
      } catch (error) {
        this.logger.error(`pending-reference tick failed: ${safeReason(error)}`, safeStack(error));
      }
    });
    return this.inFlight;
  }
}

export function pendingReferenceProviders(): Provider[] {
  return [
    {
      provide: ProcessPendingReferences,
      useFactory: (uow: UnitOfWork, clock: Clock, ids: IdGenerator, metrics: Metrics) =>
        new ProcessPendingReferences(uow, clock, ids, metrics, {
          policy: {
            ...DEFAULT_PENDING_REFERENCE_POLICY,
            maxAttempts: envInt('PENDING_REFERENCE_MAX_ATTEMPTS', DEFAULT_PENDING_REFERENCE_POLICY.maxAttempts),
            ttlMs: envInt('PENDING_REFERENCE_TTL_MS', DEFAULT_PENDING_REFERENCE_POLICY.ttlMs),
          },
        }),
      inject: [UnitOfWork, Clock, IdGenerator, Metrics],
    },
    {
      provide: PendingReferenceWorker,
      useFactory: (processor: ProcessPendingReferences) =>
        new PendingReferenceWorker(processor, envInt(PENDING_REFERENCE_POLL_INTERVAL_ENV, DEFAULT_POLL_INTERVAL_MS)),
      inject: [ProcessPendingReferences],
    },
  ];
}
