import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import {
  BRL,
  eventTypesOf,
  expectMoneyInvariants,
  startTestApps,
  wager,
  type ApiClient,
  type TestApps,
  type WagerBody,
  type WalletRef,
} from './support/test-app.ts';

let apps: TestApps;
let api: ApiClient;

beforeAll(async () => {
  apps = await startTestApps('wager_transactions_api');
  api = apps.apis[0]!;
});

afterEach(async () => {
  await expectMoneyInvariants(apps.db);
});

afterAll(async () => {
  await apps.close();
});

const reversalOf = (wallet: WalletRef, reference: WagerBody, kind: string, overrides: Record<string, unknown> = {}) =>
  wager(wallet, { kind, money: reference.money, referenceExternalTransactionId: reference.externalTransactionId, ...overrides });

async function rowsWithKey(key: string) {
  const [row] = await apps.db.sql`SELECT count(*)::int AS count FROM wager_transactions WHERE idempotency_key = ${key}`;
  return row.count as number;
}

async function ledgerEntriesOf(transactionId: string) {
  const [row] = await apps.db.sql`SELECT count(*)::int AS count FROM wallet_ledger_entries WHERE transaction_id = ${transactionId}`;
  return row.count as number;
}

describe('BET', () => {
  it('debits the wallet and answers 200 PROCESSED with the balance after it', async () => {
    const wallet = await api.wallet('1000.00');

    const res = await api.submit(wager(wallet, { money: BRL('25.00') }));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ transactionId: expect.any(String), status: 'PROCESSED', balance: BRL('975.00'), idempotentReplay: false });
    expect(await ledgerEntriesOf(res.body.transactionId)).toBe(1);
    expect(await eventTypesOf(apps.db, res.body.transactionId)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
  });

  it('answers 422 INSUFFICIENT_FUNDS above the balance and keeps the refusal as an auditable REJECTED row without ledger', async () => {
    const wallet = await api.wallet('10.00');

    const res = await api.submit(wager(wallet, { money: BRL('10.01') }));

    expect(res.status).toBe(422);
    expect(res.body).toEqual({
      transactionId: expect.any(String),
      status: 'REJECTED',
      failureCode: 'INSUFFICIENT_FUNDS',
      balance: BRL('10.00'),
      idempotentReplay: false,
    });
    expect(await ledgerEntriesOf(res.body.transactionId)).toBe(0);
    expect(await eventTypesOf(apps.db, res.body.transactionId)).toEqual(['WagerTransactionRejected']);
    expect((await api.get(`/wallets/${wallet.id}`)).body.version).toBe(1);
  });
});

describe('WIN and LOSS', () => {
  it('credits a WIN that references the BET of the same round', async () => {
    const wallet = await api.wallet('100.00');
    const bet = wager(wallet, { money: BRL('10.00') });
    await api.submit(bet);

    const res = await api.submit(wager(wallet, { kind: 'WIN', money: BRL('25.00'), referenceExternalTransactionId: bet.externalTransactionId }));

    expect(res.status).toBe(200);
    expect(res.body.balance).toEqual(BRL('115.00'));
  });

  it('records a LOSS as PROCESSED without moving the balance, the version or the ledger, and announces no balance change', async () => {
    const wallet = await api.wallet('100.00');
    const bet = wager(wallet, { money: BRL('10.00') });
    await api.submit(bet);

    const res = await api.submit(wager(wallet, { kind: 'LOSS', money: BRL('0.00'), referenceExternalTransactionId: bet.externalTransactionId }));

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'PROCESSED', balance: BRL('90.00') });
    expect(await ledgerEntriesOf(res.body.transactionId)).toBe(0);
    expect(await eventTypesOf(apps.db, res.body.transactionId)).toEqual(['WagerTransactionProcessed']);
    expect((await api.get(`/wallets/${wallet.id}`)).body.version).toBe(2);
  });
});

describe('REFUND and ROLLBACK', () => {
  it('credits a REFUND of a processed BET back to the wallet', async () => {
    const wallet = await api.wallet('100.00');
    const bet = wager(wallet, { money: BRL('40.00') });
    await api.submit(bet);

    const res = await api.submit(reversalOf(wallet, bet, 'REFUND'));

    expect(res.status).toBe(200);
    expect(res.body.balance).toEqual(BRL('100.00'));
  });

  it('refuses a second reversal of the same BET with 422 REFERENCE_ALREADY_REVERSED, whether REFUND or ROLLBACK', async () => {
    const wallet = await api.wallet('100.00');
    const bet = wager(wallet, { money: BRL('40.00') });
    await api.submit(bet);
    await api.submit(reversalOf(wallet, bet, 'REFUND'));

    const secondRefund = await api.submit(reversalOf(wallet, bet, 'REFUND'));
    const rollback = await api.submit(reversalOf(wallet, bet, 'ROLLBACK'));

    for (const res of [secondRefund, rollback]) {
      expect(res.status).toBe(422);
      expect(res.body).toMatchObject({ failureCode: 'REFERENCE_ALREADY_REVERSED', balance: BRL('100.00') });
    }
  });

  it('refuses a REFUND of a different amount than the BET with 422 AMOUNT_MISMATCH', async () => {
    const wallet = await api.wallet('100.00');
    const bet = wager(wallet, { money: BRL('40.00') });
    await api.submit(bet);

    const res = await api.submit(reversalOf(wallet, bet, 'REFUND', { money: BRL('30.00') }));

    expect(res.status).toBe(422);
    expect(res.body.failureCode).toBe('AMOUNT_MISMATCH');
  });

  it('refuses a REFUND of a WIN with 422 REFERENCE_KIND_NOT_ALLOWED', async () => {
    const wallet = await api.wallet('100.00');
    const win = wager(wallet, { kind: 'WIN', money: BRL('20.00') });
    await api.submit(win);

    const res = await api.submit(reversalOf(wallet, win, 'REFUND'));

    expect(res.status).toBe(422);
    expect(res.body.failureCode).toBe('REFERENCE_KIND_NOT_ALLOWED');
  });

  it('refuses a REFUND of a rejected BET with 422 REFERENCE_NOT_PROCESSED', async () => {
    const wallet = await api.wallet('10.00');
    const bet = wager(wallet, { money: BRL('50.00') });
    await api.submit(bet);

    const res = await api.submit(reversalOf(wallet, bet, 'REFUND'));

    expect(res.status).toBe(422);
    expect(res.body.failureCode).toBe('REFERENCE_NOT_PROCESSED');
  });

  it('refuses a REFUND whose BET belongs to another round with 422 REFERENCE_SCOPE_MISMATCH', async () => {
    const wallet = await api.wallet('100.00');
    const bet = wager(wallet, { roundId: 'round-1' });
    await api.submit(bet);

    const res = await api.submit(reversalOf(wallet, bet, 'REFUND', { roundId: 'round-2' }));

    expect(res.status).toBe(422);
    expect(res.body.failureCode).toBe('REFERENCE_SCOPE_MISMATCH');
  });

  it('debits a ROLLBACK of a WIN back out of the wallet', async () => {
    const wallet = await api.wallet('100.00');
    const win = wager(wallet, { kind: 'WIN', money: BRL('25.00') });
    await api.submit(win);

    const res = await api.submit(reversalOf(wallet, win, 'ROLLBACK'));

    expect(res.status).toBe(200);
    expect(res.body.balance).toEqual(BRL('100.00'));
  });

  it('refuses a ROLLBACK that would overdraw the wallet with REVERSAL_WOULD_OVERDRAW, not INSUFFICIENT_FUNDS, and keeps it auditable', async () => {
    const wallet = await api.wallet('0.00');
    const win = wager(wallet, { kind: 'WIN', money: BRL('50.00') });
    await api.submit(win);
    await api.submit(wager(wallet, { money: BRL('50.00') }));

    const res = await api.submit(reversalOf(wallet, win, 'ROLLBACK'));

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ status: 'REJECTED', failureCode: 'REVERSAL_WOULD_OVERDRAW', balance: BRL('0.00') });
    expect(await eventTypesOf(apps.db, res.body.transactionId)).toEqual(['WagerTransactionRejected']);
  });

  it('accepts a ROLLBACK that arrives before its BET with 202 PENDING_REFERENCE and announces it', async () => {
    const wallet = await api.wallet('100.00');
    const lateBet = wager(wallet, { money: BRL('10.00') });

    const res = await api.submit(reversalOf(wallet, lateBet, 'ROLLBACK'));

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ transactionId: expect.any(String), status: 'PENDING_REFERENCE', balance: BRL('100.00'), idempotentReplay: false });
    expect(await ledgerEntriesOf(res.body.transactionId)).toBe(0);
    expect(await eventTypesOf(apps.db, res.body.transactionId)).toEqual(['WagerTransactionPendingReference']);
  });
});

describe('wallet and currency checks', () => {
  it('persists a transaction in another currency than the wallet as REJECTED CURRENCY_MISMATCH, answering with the wallet balance', async () => {
    const wallet = await api.wallet('100.00');

    const res = await api.submit(wager(wallet, { money: { amount: '10.00', currency: 'USD' } }));

    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ failureCode: 'CURRENCY_MISMATCH', balance: BRL('100.00') });
    const stored = await api.get(`/wagering/transactions/${res.body.transactionId}`);
    expect(stored.body).toMatchObject({ money: { amount: '10.00', currency: 'USD' }, balance: BRL('100.00') });
  });

  it('refuses a transaction for a player who does not own the wallet with 422 WALLET_PLAYER_MISMATCH', async () => {
    const wallet = await api.wallet('100.00');

    const res = await api.submit(wager({ ...wallet, playerId: crypto.randomUUID() }));

    expect(res.status).toBe(422);
    expect(res.body.failureCode).toBe('WALLET_PLAYER_MISMATCH');
  });

  it('answers 404 WALLET_NOT_FOUND for a wallet that does not exist and persists nothing', async () => {
    const body = wager({ id: crypto.randomUUID(), playerId: crypto.randomUUID() });

    const res = await api.submit(body);

    expect(res.status).toBe(404);
    expect(res.body.failureCode).toBe('WALLET_NOT_FOUND');
    expect(await rowsWithKey(`${body.providerId}:${body.externalTransactionId}`)).toBe(0);
  });
});

describe('idempotency', () => {
  it('replays an identical request with the original result and the balance observed back then, even after later movements', async () => {
    const wallet = await api.wallet('100.00');
    const bet = wager(wallet, { money: BRL('30.00') });
    const original = await api.submit(bet, 'key-replay', { 'x-correlation-id': 'first' });
    await api.submit(wager(wallet, { money: BRL('20.00') }));

    const replay = await api.submit(bet, 'key-replay', { 'x-correlation-id': 'second' });

    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ ...original.body, idempotentReplay: true });
    expect(replay.body.balance).toEqual(BRL('70.00'));
    expect(await ledgerEntriesOf(original.body.transactionId)).toBe(1);
  });

  it('replays a rejected request with the same 422, failure code and observed balance', async () => {
    const wallet = await api.wallet('10.00');
    const bet = wager(wallet, { money: BRL('50.00') });
    const original = await api.submit(bet);
    await api.submit(wager(wallet, { kind: 'WIN', money: BRL('100.00') }));

    const replay = await api.submit(bet);

    expect(replay.status).toBe(422);
    expect(replay.body).toEqual({ ...original.body, idempotentReplay: true });
  });

  it('answers 409 IDEMPOTENCY_CONFLICT when the same key arrives with a different payload, and persists nothing new', async () => {
    const wallet = await api.wallet('100.00');
    const bet = wager(wallet, { money: BRL('10.00') });
    await api.submit(bet, 'key-conflict');

    const res = await api.submit({ ...bet, money: BRL('11.00') }, 'key-conflict');

    expect(res.status).toBe(409);
    expect(res.body.failureCode).toBe('IDEMPOTENCY_CONFLICT');
    expect(await rowsWithKey('key-conflict')).toBe(1);
    expect((await api.get(`/wallets/${wallet.id}`)).body.balance).toEqual(BRL('90.00'));
  });

  it('answers 409 IDEMPOTENCY_CONFLICT when the external transaction id was already used under another key', async () => {
    const wallet = await api.wallet('100.00');
    const bet = wager(wallet);
    await api.submit(bet, 'key-one');

    const res = await api.submit(bet, 'key-two');

    expect(res.status).toBe(409);
    expect(res.body.failureCode).toBe('IDEMPOTENCY_CONFLICT');
    expect(await rowsWithKey('key-two')).toBe(0);
  });
});

describe('payload validation', () => {
  const selfReferencing = (body: WagerBody) => ({ ...body, referenceExternalTransactionId: body.externalTransactionId });
  const invalid: [string, (wallet: WalletRef) => WagerBody, string][] = [
    ['an OPENING, which is internal only', (w) => wager(w, { kind: 'OPENING' }), 'KIND_NOT_SUBMITTABLE'],
    ['a kind outside the operation list', (w) => wager(w, { kind: 'BONUS' }), 'INVALID_PAYLOAD'],
    ['an amount with one decimal', (w) => wager(w, { money: { amount: '10.5', currency: 'BRL' } }), 'INVALID_MONEY'],
    ['an amount sent as a JSON number', (w) => wager(w, { money: { amount: 10, currency: 'BRL' } }), 'INVALID_MONEY'],
    ['a REFUND without the reference it reverses', (w) => wager(w, { kind: 'REFUND' }), 'INVALID_PAYLOAD'],
    ['a ROLLBACK that references itself, which could only resolve after a 24 h wait', (w) => selfReferencing(wager(w, { kind: 'ROLLBACK' })), 'INVALID_PAYLOAD'],
    ['a BET carrying a reference, which no rule gives a meaning to', (w) => wager(w, { referenceExternalTransactionId: 'ext-1' }), 'INVALID_PAYLOAD'],
    ['a payload without a roundId', (w) => wager(w, { roundId: undefined }), 'INVALID_PAYLOAD'],
    ['a walletId that is not a UUID', (w) => wager(w, { walletId: 'wallet-1' }), 'INVALID_PAYLOAD'],
  ];

  for (const [description, build, code] of invalid) {
    it(`refuses ${description} with 400 ${code} and persists nothing`, async () => {
      const wallet = await api.wallet('100.00');
      const body = build(wallet);

      const res = await api.submit(body);

      expect(res.status).toBe(400);
      expect(res.body.failureCode).toBe(code);
      expect(await rowsWithKey(`${body.providerId}:${body.externalTransactionId}`)).toBe(0);
    });
  }

  it('refuses a request without the Idempotency-Key header with 400 MISSING_IDEMPOTENCY_KEY', async () => {
    const wallet = await api.wallet('100.00');

    const res = await api.submit(wager(wallet), null);

    expect(res.status).toBe(400);
    expect(res.body.failureCode).toBe('MISSING_IDEMPOTENCY_KEY');
  });

  it('refuses a body that is not valid JSON with 400 INVALID_PAYLOAD', async () => {
    const res = await api.postRaw('/wagering/transactions', '{"kind": "BET",', { 'idempotency-key': 'key-broken-json' });

    expect(res.status).toBe(400);
    expect(res.body.failureCode).toBe('INVALID_PAYLOAD');
  });
});

describe('transaction lookups', () => {
  it('returns a stored transaction by id with its status, failure code and observed balance', async () => {
    const wallet = await api.wallet('10.00');
    const bet = wager(wallet, { money: BRL('50.00') });
    const submitted = await api.submit(bet);

    const res = await api.get(`/wagering/transactions/${submitted.body.transactionId}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: submitted.body.transactionId,
      providerId: 'provider-a',
      externalTransactionId: bet.externalTransactionId,
      walletId: wallet.id,
      kind: 'BET',
      money: BRL('50.00'),
      status: 'REJECTED',
      failureCode: 'INSUFFICIENT_FUNDS',
      balance: BRL('10.00'),
    });
  });

  it('returns the same transaction by provider and external transaction id', async () => {
    const wallet = await api.wallet('100.00');
    const bet = wager(wallet);
    const submitted = await api.submit(bet);

    const res = await api.get(`/providers/${bet.providerId}/wagering/transactions/${bet.externalTransactionId}`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: submitted.body.transactionId, status: 'PROCESSED' });
  });

  it('answers 404 TRANSACTION_NOT_FOUND for an unknown transaction on both lookups', async () => {
    const byId = await api.get(`/wagering/transactions/${crypto.randomUUID()}`);
    const byProvider = await api.get('/providers/provider-a/wagering/transactions/never-sent');

    for (const res of [byId, byProvider]) {
      expect(res.status).toBe(404);
      expect(res.body.failureCode).toBe('TRANSACTION_NOT_FOUND');
    }
  });
});
