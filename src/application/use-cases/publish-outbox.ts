import type { Clock } from '../ports/clock.ts';
import type { EventPublisher } from '../ports/event-publisher.ts';
import type { UnitOfWork } from '../ports/unit-of-work.ts';
import type { Metrics } from '../ports/metrics.ts';

export const OUTBOX_BATCH_SIZE = 50;

export interface PublishOutboxResult {
  published: number;
  failed: number;
}

/** One publisher round in one SQL transaction: claim due rows (skipping rows another publisher holds), publish, record, commit. */
export class PublishOutbox {
  constructor(
    private readonly uow: UnitOfWork,
    private readonly publisher: EventPublisher,
    private readonly clock: Clock,
    private readonly metrics: Metrics,
  ) {}

  // A crash between publish and commit republishes the row later; the consumer dedups on eventId, so duplicate beats lost.
  execute(): Promise<PublishOutboxResult> {
    return this.uow.transaction(async ({ outbox }) => {
      const result: PublishOutboxResult = { published: 0, failed: 0 };
      for (const message of await outbox.claimDue(this.clock.now(), OUTBOX_BATCH_SIZE)) {
        try {
          await this.publisher.publish(message);
          message.markPublished(this.clock.now());
          result.published += 1;
        } catch {
          message.scheduleRetry(this.clock.now());
          this.metrics.retried('outbox_publish');
          result.failed += 1;
        }
        await outbox.save(message);
      }
      return result;
    });
  }
}
