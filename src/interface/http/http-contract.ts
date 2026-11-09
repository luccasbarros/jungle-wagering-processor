import { FailureCode } from '../../domain/failure-codes.ts';
import { WagerTransactionStatus } from '../../domain/wager-transaction.ts';

// One table for every endpoint, so a provider decides retry/fix/give up from the status code alone (plan 4.4).
export const HTTP_STATUS_BY_FAILURE_CODE: Partial<Record<FailureCode, number>> = {
  [FailureCode.InvalidPayload]: 400,
  [FailureCode.InvalidMoney]: 400,
  [FailureCode.MissingIdempotencyKey]: 400,
  [FailureCode.KindNotSubmittable]: 400,
  [FailureCode.WalletNotFound]: 404,
  [FailureCode.TransactionNotFound]: 404,
  [FailureCode.IdempotencyConflict]: 409,
  [FailureCode.WalletAlreadyExists]: 409,
  [FailureCode.TransientFailure]: 503,
};

/** A business refusal that escaped as an error instead of a REJECTED row still reads as a rule violation. */
export const UNMAPPED_DOMAIN_ERROR_STATUS = 422;

// Pure function of the stored status, so a replay answers exactly what the original did.
export const HTTP_STATUS_BY_TRANSACTION_STATUS: Partial<Record<WagerTransactionStatus, number>> = {
  [WagerTransactionStatus.Processed]: 200,
  [WagerTransactionStatus.Rejected]: 422,
  [WagerTransactionStatus.PendingReference]: 202,
};

export const RETRY_AFTER_SECONDS = '1';

export const CORRELATION_HEADER = 'x-correlation-id';
const MAX_CORRELATION_ID_LENGTH = 255;

export const correlationIdFrom = (header: string | undefined): string =>
  header && header.length <= MAX_CORRELATION_ID_LENGTH ? header : crypto.randomUUID();
