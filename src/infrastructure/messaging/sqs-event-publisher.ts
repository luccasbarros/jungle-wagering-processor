import { SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { OutboxMessage } from '../../domain/outbox-message.ts';
import { EventPublisher } from '../../application/ports/event-publisher.ts';

export class SqsEventPublisher extends EventPublisher {
  constructor(
    private readonly sqs: SQSClient,
    private readonly queueUrl: string,
  ) {
    super();
  }

  // Group = aggregate (wallet) keeps one wallet's events in order; dedup id = eventId makes a republish a no-op for 5 min.
  async publish(message: OutboxMessage): Promise<void> {
    await this.sqs.send(
      new SendMessageCommand({
        QueueUrl: this.queueUrl,
        MessageBody: JSON.stringify(message.payload),
        MessageGroupId: message.aggregateId,
        MessageDeduplicationId: message.id,
      }),
    );
  }

  onApplicationShutdown(): void {
    this.sqs.destroy();
  }
}
