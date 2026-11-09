import { Logger } from '@nestjs/common';
import { SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import type { OutboxMessage } from '../../domain/outbox-message.ts';
import { EventPublisher } from '../../application/ports/event-publisher.ts';
import { logContext, type LogFields } from '../../application/log-context.ts';

interface EnvelopeIds {
  correlationId?: string;
  data?: { transactionId?: string; providerId?: string };
}

export class SqsEventPublisher extends EventPublisher {
  private readonly logger = new Logger(SqsEventPublisher.name);

  constructor(
    private readonly sqs: SQSClient,
    private readonly queueUrl: string,
  ) {
    super();
  }

  // Group = aggregate (wallet) keeps one wallet's events in order; dedup id = eventId makes a republish a no-op for 5 min.
  async publish(message: OutboxMessage): Promise<void> {
    try {
      await this.sqs.send(
        new SendMessageCommand({
          QueueUrl: this.queueUrl,
          MessageBody: JSON.stringify(message.payload),
          MessageGroupId: message.aggregateId,
          MessageDeduplicationId: message.id,
        }),
      );
    } catch (error) {
      const reason = error instanceof Error ? error.name : 'UnknownError';
      logContext.run(logFieldsOf(message), () => this.logger.warn(`outbox: ${message.eventType} ${message.id} failed to publish (${reason})`));
      throw error;
    }
  }

  onApplicationShutdown(): void {
    this.sqs.destroy();
  }
}

// The envelope already carries the request's correlationId, so a publish failure traces back to the request that caused it.
function logFieldsOf(message: OutboxMessage): LogFields {
  const { correlationId, data } = message.payload as EnvelopeIds;
  return { correlationId, walletId: message.aggregateId, transactionId: data?.transactionId, providerId: data?.providerId };
}
