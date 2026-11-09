import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { canonicalJson, wagerPayloadHash } from '../../../src/domain/payload-hash.ts';
import { Money } from '../../../src/domain/money.ts';
import { WagerTransaction, WagerTransactionKind, type WagerPayload } from '../../../src/domain/wager-transaction.ts';

const payload: WagerPayload = {
  providerId: 'provider-a',
  externalTransactionId: 'transaction-123',
  playerId: 'player-1',
  walletId: 'wallet-1',
  roundId: 'round-987',
  gameId: 'fortune-chimp',
  kind: WagerTransactionKind.Bet,
  money: Money.from({ amount: '25.00', currency: 'BRL' }),
};

describe('canonicalJson', () => {
  it('sorts keys recursively and drops whitespace, so field order on the wire does not change the hash', () => {
    expect(canonicalJson({ b: 1, a: { d: 'x', c: 'y' } })).toBe('{"a":{"c":"y","d":"x"},"b":1}');
    expect(canonicalJson({ a: { c: 'y', d: 'x' }, b: 1 })).toBe(canonicalJson({ b: 1, a: { d: 'x', c: 'y' } }));
  });

  it('omits undefined fields so an absent optional and an undefined one hash the same', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('keeps array order, since position is meaning there', () => {
    expect(canonicalJson([{ b: 1, a: 2 }, 3])).toBe('[{"a":2,"b":1},3]');
  });
});

describe('wagerPayloadHash', () => {
  it('is the sha256 hex of the canonical business fields', () => {
    const expected = createHash('sha256')
      .update(
        '{"externalTransactionId":"transaction-123","gameId":"fortune-chimp","kind":"BET","money":{"amount":"25.00","currency":"BRL"},' +
          '"playerId":"player-1","providerId":"provider-a","roundId":"round-987","walletId":"wallet-1"}',
      )
      .digest('hex');
    expect(wagerPayloadHash(payload)).toBe(expected);
  });

  it.each([
    ['amount', { money: Money.from({ amount: '25.01', currency: 'BRL' }) }],
    ['currency', { money: Money.from({ amount: '25.00', currency: 'USD' }) }],
    ['kind', { kind: WagerTransactionKind.Win }],
    ['round', { roundId: 'round-988' }],
    ['reference', { referenceExternalTransactionId: 'transaction-1' }],
  ])('changes when the %s changes, so a divergent payload under the same key is a conflict', (_label, change) => {
    expect(wagerPayloadHash({ ...payload, ...change })).not.toBe(wagerPayloadHash(payload));
  });

  it('treats a null reference like a missing one, so the same request with an explicit null is not a false conflict', () => {
    const withNull = { ...payload, referenceExternalTransactionId: null as unknown as undefined };
    expect(wagerPayloadHash(withNull)).toBe(wagerPayloadHash(payload));
  });

  it('ignores extra transport fields passed along with the business ones', () => {
    const withTransport = { ...payload, idempotencyKey: 'other-key', messageId: 'msg-1', occurredAt: '2026-11-09T00:00:00Z' };
    expect(wagerPayloadHash(withTransport)).toBe(wagerPayloadHash(payload));
  });
});

describe('WagerTransaction payload matching', () => {
  const create = (overrides: Partial<WagerPayload> & { idempotencyKey?: string } = {}) =>
    WagerTransaction.create({
      id: 'tx-1',
      idempotencyKey: 'provider-a:transaction-123',
      createdAt: new Date('2026-11-09T00:00:00Z'),
      ...payload,
      ...overrides,
    });

  it('matches an identical resubmission, which makes it a replay', () => {
    expect(create().matchesPayload(wagerPayloadHash(payload))).toBe(true);
  });

  it('does not match the same idempotency key carrying a different amount, which makes it a conflict', () => {
    const divergent = { ...payload, money: Money.from({ amount: '30.00', currency: 'BRL' }) };
    expect(create().matchesPayload(wagerPayloadHash(divergent))).toBe(false);
  });

  it('hashes the same business payload equally under two different idempotency keys', () => {
    expect(create({ idempotencyKey: 'a' }).payloadHash).toBe(create({ idempotencyKey: 'b' }).payloadHash);
  });
});
