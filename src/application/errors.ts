import { FailureCode } from '../domain/failure-codes.ts';

/** Infrastructure hiccup (lock timeout, deadlock, lost connection, concurrent version bump): the same request may succeed later. */
export class TransientFailureError extends Error {
  readonly code = FailureCode.TransientFailure;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
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
