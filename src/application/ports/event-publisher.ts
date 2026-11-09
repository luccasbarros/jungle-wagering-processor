import type { OutboxMessage } from '../../domain/outbox-message.ts';

/** Hands one outbox message to the broker; resolves only once the broker accepted it. */
export abstract class EventPublisher {
  abstract publish(message: OutboxMessage): Promise<void>;
}
