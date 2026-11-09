import type { IntegrationEvent } from './events/integration-event.ts';
import { InvariantViolationError } from './errors/domain-errors.ts';

export const OUTBOX_BASE_RETRY_DELAY_MS = 1_000;
export const OUTBOX_MAX_RETRY_DELAY_MS = 5 * 60 * 1_000;

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
}

export class OutboxMessage {
  private constructor(private readonly state: OutboxMessageState) {}

  // id = eventId, so a republish after a crash carries the same id the consumer deduplicates on.
  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    return new OutboxMessage({
      id: event.eventId,
      aggregateId: event.aggregateId,
      eventType: event.eventType,
      payload: Object.freeze({ ...event.toJSON() }),
      occurredAt: event.occurredAt,
      attempts: 0,
    });
  }

  static rehydrate(state: OutboxMessageState): OutboxMessage {
    return new OutboxMessage({ ...state });
  }

  get id(): string { return this.state.id; }
  get aggregateId(): string { return this.state.aggregateId; }
  get eventType(): string { return this.state.eventType; }
  get payload(): Readonly<Record<string, unknown>> { return this.state.payload; }
  get occurredAt(): Date { return this.state.occurredAt; }
  get attempts(): number { return this.state.attempts; }
  get nextAttemptAt(): Date | undefined { return this.state.nextAttemptAt; }
  get publishedAt(): Date | undefined { return this.state.publishedAt; }

  isPending(): boolean {
    return this.state.publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    const next = this.state.nextAttemptAt;
    return this.isPending() && (next === undefined || next.getTime() <= now.getTime());
  }

  markPublished(at: Date): void {
    if (!this.isPending()) throw new InvariantViolationError(`outbox message ${this.id} is already published`);
    this.state.publishedAt = at;
  }

  // ponytail: retries forever with a 5 min cap; the outbox lag metric is what surfaces a stuck message.
  scheduleRetry(now: Date): void {
    this.state.attempts += 1;
    const delay = Math.min(2 ** this.state.attempts * OUTBOX_BASE_RETRY_DELAY_MS, OUTBOX_MAX_RETRY_DELAY_MS);
    this.state.nextAttemptAt = new Date(now.getTime() + delay);
  }
}
