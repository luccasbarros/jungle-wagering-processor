import { describe, expect, it } from 'bun:test';
import { safeReason, safeStack } from '../../../src/application/errors.ts';

// What a Postgres driver error looks like: the failing statement, parameters included.
const driverError = () => Object.assign(new Error("update wager_transactions set amount = '250.00' where id = 'tx-1' - duplicate key"), { code: '23505' });

describe('safeReason', () => {
  it('keeps the class name and the driver code but drops the message, where SQL parameters carry amounts', () => {
    const reason = safeReason(driverError());
    expect(reason).toBe('Error (23505)');
    expect(reason).not.toContain('250.00');
  });

  it('names an error without a code by its name alone', () => {
    expect(safeReason(new TypeError('endpoint http://sqs amount=1.00 refused'))).toBe('TypeError');
  });

  it('labels a thrown non-error as unknown', () => {
    expect(safeReason('amount=10.00')).toBe('UnknownError');
  });
});

describe('safeStack', () => {
  it('returns only the frames, never the first line that repeats the message', () => {
    const stack = safeStack(driverError())!;
    expect(stack).not.toContain('250.00');
    expect(stack.split('\n').every((line) => line.startsWith('    at '))).toBe(true);
    expect(stack.length).toBeGreaterThan(0);
  });

  it('has nothing for a thrown non-error', () => {
    expect(safeStack('boom')).toBeUndefined();
  });
});
