import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { BRL, eventTypesOf, expectMoneyInvariants, startTestApps, wager, type ApiClient, type TestApps } from './support/test-app.ts';

let apps: TestApps;
let api: ApiClient;

beforeAll(async () => {
  apps = await startTestApps('wallets_api');
  api = apps.apis[0]!;
});

afterEach(async () => {
  await expectMoneyInvariants(apps.db);
});

afterAll(async () => {
  await apps.close();
});

describe('POST /wallets', () => {
  it('opens a wallet at version 1 holding its initial balance', async () => {
    const playerId = crypto.randomUUID();
    const res = await api.openWallet(BRL('1000.00'), playerId);

    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: expect.any(String), playerId, balance: BRL('1000.00'), version: 1 });
  });

  it('books the initial balance as an internal OPENING credit in the same SQL transaction', async () => {
    const res = await api.openWallet(BRL('100.00'));

    const rows = await apps.db.sql`
      SELECT t.id, t.kind, t.status, t.provider_id, e.direction, e.amount::text, e.balance_before::text, e.balance_after::text
      FROM wallet_ledger_entries e JOIN wager_transactions t ON t.id = e.transaction_id
      WHERE e.wallet_id = ${res.body.id}`;
    expect(rows).toEqual([
      {
        id: expect.any(String),
        kind: 'OPENING',
        status: 'PROCESSED',
        provider_id: 'internal',
        direction: 'CREDIT',
        amount: '100.00',
        balance_before: '0.00',
        balance_after: '100.00',
      },
    ]);
    expect(await eventTypesOf(apps.db, rows[0].id)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
  });

  it('opens a wallet with a zero balance without any OPENING transaction or ledger entry', async () => {
    const res = await api.openWallet(BRL('0.00'));

    expect(res.status).toBe(201);
    const [counts] = await apps.db.sql`
      SELECT (SELECT count(*)::int FROM wager_transactions WHERE wallet_id = ${res.body.id}) AS transactions,
             (SELECT count(*)::int FROM wallet_ledger_entries WHERE wallet_id = ${res.body.id}) AS entries`;
    expect(counts).toEqual({ transactions: 0, entries: 0 });
  });

  it('refuses a second wallet for the same player and currency with 409 WALLET_ALREADY_EXISTS', async () => {
    const playerId = crypto.randomUUID();
    await api.wallet('10.00', playerId);

    const res = await api.openWallet(BRL('20.00'), playerId);

    expect(res.status).toBe(409);
    expect(res.body.failureCode).toBe('WALLET_ALREADY_EXISTS');
  });

  it('opens a second wallet for the same player in another currency', async () => {
    const playerId = crypto.randomUUID();
    await api.wallet('10.00', playerId);

    const res = await api.openWallet({ amount: '10.00', currency: 'USD' }, playerId);

    expect(res.status).toBe(201);
    expect(res.body.balance).toEqual({ amount: '10.00', currency: 'USD' });
  });

  it('refuses an initial balance sent as a JSON number with 400 INVALID_MONEY', async () => {
    const res = await api.openWallet({ amount: 100, currency: 'BRL' });

    expect(res.status).toBe(400);
    expect(res.body.failureCode).toBe('INVALID_MONEY');
  });

  it('refuses a body without a playerId with 400 INVALID_PAYLOAD', async () => {
    const res = await api.postRaw('/wallets', JSON.stringify({ initialBalance: BRL('10.00') }));

    expect(res.status).toBe(400);
    expect(res.body.failureCode).toBe('INVALID_PAYLOAD');
  });
});

describe('GET /wallets/:walletId', () => {
  it('returns the balance and the version after a movement', async () => {
    const wallet = await api.wallet('100.00');
    await api.submit(wager(wallet, { money: BRL('30.00') }));

    const res = await api.get(`/wallets/${wallet.id}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: wallet.id, playerId: wallet.playerId, balance: BRL('70.00'), version: 2 });
  });

  it('answers 404 WALLET_NOT_FOUND for a wallet that does not exist', async () => {
    const res = await api.get(`/wallets/${crypto.randomUUID()}`);

    expect(res.status).toBe(404);
    expect(res.body.failureCode).toBe('WALLET_NOT_FOUND');
  });

  it('answers 400 INVALID_PAYLOAD for a wallet id that is not a UUID', async () => {
    const res = await api.get('/wallets/not-a-uuid');

    expect(res.status).toBe(400);
    expect(res.body.failureCode).toBe('INVALID_PAYLOAD');
  });
});
