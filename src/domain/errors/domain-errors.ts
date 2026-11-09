import { FailureCode } from '../failure-codes.ts';

/** A business or input rule refused the operation; `code` tells the caller what to do next. */
export class DomainError extends Error {
  constructor(
    public readonly code: FailureCode,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidMoneyError extends DomainError {
  constructor(message: string) {
    super(FailureCode.InvalidMoney, message);
  }
}

export class CurrencyMismatchError extends DomainError {
  constructor(expected: string, actual: string) {
    super(FailureCode.CurrencyMismatch, `currency mismatch: expected ${expected}, got ${actual}`);
  }
}

export class InsufficientFundsError extends DomainError {
  constructor() {
    super(FailureCode.InsufficientFunds, 'operation would make the balance negative');
  }
}

/** A programming error: the caller broke an invariant the domain never lets through. Not a business path. */
export class InvariantViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidTransactionStateError extends InvariantViolationError {}
