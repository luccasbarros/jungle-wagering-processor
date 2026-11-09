import { Logger, type Provider } from '@nestjs/common';
import { SQSClient } from '@aws-sdk/client-sqs';
import { Clock } from '../../application/ports/clock.ts';
import { EventPublisher } from '../../application/ports/event-publisher.ts';
import { UnitOfWork } from '../../application/ports/unit-of-work.ts';
import { Metrics } from '../../application/ports/metrics.ts';
import { OUTBOX_BATCH_SIZE, PublishOutbox } from '../../application/use-cases/publish-outbox.ts';
import { SqsEventPublisher } from './sqs-event-publisher.ts';
import { createSqsClient, wagerEventsQueueUrl } from './sqs.ts';

export const OUTBOX_POLL_INTERVAL_MS = 500;

/** Runs PublishOutbox for the life of the Nest app; a full batch polls again at once, otherwise it waits the interval. */
export class OutboxPublisherLoop {
  private readonly logger = new Logger(OutboxPublisherLoop.name);
  private running = false;
  private wake: (() => void) | undefined;
  private loop: Promise<void> = Promise.resolve();

  constructor(
    private readonly publishOutbox: PublishOutbox,
    private readonly intervalMs: number = OUTBOX_POLL_INTERVAL_MS,
  ) {}

  onApplicationBootstrap(): void {
    this.running = true;
    this.loop = this.run();
  }

  // before, not on, ApplicationShutdown: the in-flight batch must finish while the ORM is still open.
  async beforeApplicationShutdown(): Promise<void> {
    this.running = false;
    this.wake?.();
    await this.loop;
  }

  private async run(): Promise<void> {
    while (this.running) {
      let claimed = 0;
      try {
        const { published, failed } = await this.publishOutbox.execute();
        claimed = published + failed;
        if (failed > 0) this.logger.warn(`outbox: ${failed} message(s) failed to publish, retry scheduled`);
      } catch (error) {
        this.logger.warn(`outbox: round failed, will retry (${error instanceof Error ? error.message : String(error)})`);
      }
      if (claimed < OUTBOX_BATCH_SIZE) await this.pause();
    }
  }

  private pause(): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, this.intervalMs);
      this.wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
}

export const OUTBOX_PROVIDERS: Provider[] = [
  { provide: SQSClient, useFactory: () => createSqsClient() },
  { provide: EventPublisher, useFactory: (sqs: SQSClient) => new SqsEventPublisher(sqs, wagerEventsQueueUrl()), inject: [SQSClient] },
  {
    provide: PublishOutbox,
    useFactory: (uow: UnitOfWork, publisher: EventPublisher, clock: Clock, metrics: Metrics) => new PublishOutbox(uow, publisher, clock, metrics),
    inject: [UnitOfWork, EventPublisher, Clock, Metrics],
  },
  { provide: OutboxPublisherLoop, useFactory: (publishOutbox: PublishOutbox) => new OutboxPublisherLoop(publishOutbox), inject: [PublishOutbox] },
];
