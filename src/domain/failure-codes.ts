/** Stable machine-readable codes; never reuse one with a different meaning. */
export enum FailureCode {
  InsufficientFunds = 'INSUFFICIENT_FUNDS',
  ReversalWouldOverdraw = 'REVERSAL_WOULD_OVERDRAW',
  CurrencyMismatch = 'CURRENCY_MISMATCH',
  WalletPlayerMismatch = 'WALLET_PLAYER_MISMATCH',
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  ReferenceKindNotAllowed = 'REFERENCE_KIND_NOT_ALLOWED',
  ReferenceScopeMismatch = 'REFERENCE_SCOPE_MISMATCH',
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  ReferenceAlreadyReversed = 'REFERENCE_ALREADY_REVERSED',
  AmountMismatch = 'AMOUNT_MISMATCH',
  InvalidPayload = 'INVALID_PAYLOAD',
  InvalidMoney = 'INVALID_MONEY',
  MissingIdempotencyKey = 'MISSING_IDEMPOTENCY_KEY',
  KindNotSubmittable = 'KIND_NOT_SUBMITTABLE',
  IdempotencyConflict = 'IDEMPOTENCY_CONFLICT',
  WalletNotFound = 'WALLET_NOT_FOUND',
  WalletAlreadyExists = 'WALLET_ALREADY_EXISTS',
  TransactionNotFound = 'TRANSACTION_NOT_FOUND',
  TransientFailure = 'TRANSIENT_FAILURE',
  PermanentFailure = 'PERMANENT_FAILURE',
}

/** Codes a persisted transaction can be REJECTED with (business rule, not infrastructure). */
export type RejectionCode =
  | FailureCode.InsufficientFunds
  | FailureCode.ReversalWouldOverdraw
  | FailureCode.CurrencyMismatch
  | FailureCode.WalletPlayerMismatch
  | FailureCode.ReferenceNotFound
  | FailureCode.ReferenceKindNotAllowed
  | FailureCode.ReferenceScopeMismatch
  | FailureCode.ReferenceNotProcessed
  | FailureCode.ReferenceAlreadyReversed
  | FailureCode.AmountMismatch;
