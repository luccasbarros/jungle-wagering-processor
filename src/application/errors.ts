import { FailureCode } from '../domain/failure-codes.ts';
import type { LockConflictReason } from './ports/metrics.ts';

/** Class name and driver/SQLSTATE code only: a driver message echoes the failing statement, SQL parameters and amounts included (spec 12). */
export function safeReason(error: unknown): string {
  if (!(error instanceof Error)) return 'UnknownError';
  const { code } = error as { code?: unknown };
  return typeof code === 'string' ? `${error.name} (${code})` : error.name;
}

/** Stack frames without the first line, which repeats the message. */
export function safeStack(error: unknown): string | undefined {
  if (!(error instanceof Error) || !error.stack) return undefined;
  return error.stack.split('\n').filter((line) => line.startsWith('    at ')).join('\n');
}

/** Infrastructure hiccup (lock timeout, deadlock, lost connection, concurrent version bump): the same request may succeed later. */
export class TransientFailureError extends Error {
  readonly code = FailureCode.TransientFailure;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Two writers met on the same wallet; still a 503, but counted apart from a database outage. */
export class LockConflictError extends TransientFailureError {
  constructor(
    public readonly reason: LockConflictReason,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export type DuplicateTransactionField = 'idempotencyKey' | 'externalTransactionId';

/** The transaction insert lost a uniqueness race; the use case answers with the stored one. */
export class DuplicateTransactionError extends Error {
  constructor(public readonly field: DuplicateTransactionField) {
    super(`a wager transaction with the same ${field} already exists`);
    this.name = new.target.name;
  }
}

/** The broker delivered a message this consumer already committed; the consumer acks it without effect. */
export class DuplicateInboxMessageError extends Error {
  constructor() {
    super('inbox message already recorded');
    this.name = new.target.name;
  }
}
