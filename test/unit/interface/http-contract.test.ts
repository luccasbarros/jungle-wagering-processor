import { describe, expect, it } from 'bun:test';
import { WagerTransactionStatus as Status } from '../../../src/domain/wager-transaction.ts';
import { InvariantViolationError } from '../../../src/domain/errors/domain-errors.ts';
import { httpStatusFor } from '../../../src/interface/http/http-contract.ts';

describe('httpStatusFor', () => {
  it.each([
    [Status.Processed, 200],
    [Status.Rejected, 422],
    [Status.Failed, 422],
    [Status.PendingReference, 202],
  ])('answers %s with %i, so an original and its replay always share the status code', (status, expected) => {
    expect(httpStatusFor(status)).toBe(expected);
  });

  it('refuses to answer for PENDING, which never leaves the use case', () => {
    expect(() => httpStatusFor(Status.Pending)).toThrow(InvariantViolationError);
  });
});
