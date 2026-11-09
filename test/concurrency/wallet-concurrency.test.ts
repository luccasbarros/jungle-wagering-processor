import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import {
  BRL,
  expectMoneyInvariants,
  startTestApps,
  wager,
  type ApiClient,
  type ApiResponse,
  type TestApps,
} from '../integration/support/test-app.ts';

const INSTANCES = 3;

let apps: TestApps;

beforeAll(async () => {
  apps = await startTestApps('wallet_concurrency', INSTANCES);
});

afterEach(async () => {
  await expectMoneyInvariants(apps.db);
});

afterAll(async () => {
  await apps.close();
});

// Round-robin over the instances so concurrent requests hit different processes' pools.
const instance = (i: number): ApiClient => apps.apis[i % INSTANCES]!;

async function walletState(walletId: string) {
  const [row] = await apps.db.sql`
    SELECT w.balance::text AS balance, w.version,
           (SELECT count(*)::int FROM wallet_ledger_entries e WHERE e.wallet_id = w.id AND e.direction = 'DEBIT') AS debits
    FROM wallets w WHERE w.id = ${walletId}`;
  return row as { balance: string; version: number; debits: number };
}

const statusesOf = (responses: ApiResponse[]) => responses.map((res) => res.status).sort();

describe('two bets racing for the same balance', () => {
  it('processes exactly one of two concurrent 80.00 bets on 100.00, rejects the other, and leaves 20.00 with one debit', async () => {
    const wallet = await instance(0).wallet('100.00');
    const bets = [wager(wallet, { money: BRL('80.00') }), wager(wallet, { money: BRL('80.00') })];

    const responses = await Promise.all(bets.map((bet, i) => instance(i).submit(bet)));

    expect(statusesOf(responses)).toEqual([200, 422]);
    const rejected = responses.find((res) => res.status === 422)!;
    expect(rejected.body).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS', balance: BRL('20.00') });
    expect(await walletState(wallet.id)).toEqual({ balance: '20.00', version: 2, debits: 1 });

    const retries = await Promise.all(bets.map((bet, i) => instance(i + 1).submit(bet)));

    expect(statusesOf(retries)).toEqual([200, 422]);
    expect(retries.every((res) => res.body.idempotentReplay)).toBe(true);
    expect(await walletState(wallet.id)).toEqual({ balance: '20.00', version: 2, debits: 1 });
  });

  it('processes exactly five of ten concurrent 20.00 bets on 100.00 and empties the wallet', async () => {
    const wallet = await instance(0).wallet('100.00');

    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, i) => instance(i).submit(wager(wallet, { money: BRL('20.00') }))),
    );

    expect(responses.filter((res) => res.status === 200)).toHaveLength(5);
    expect(responses.filter((res) => res.body.failureCode === 'INSUFFICIENT_FUNDS')).toHaveLength(5);
    expect(await walletState(wallet.id)).toEqual({ balance: '0.00', version: 6, debits: 5 });
  });
});

describe('the same bet delivered many times at once', () => {
  it('debits once when the same bet arrives 50 times in parallel, and every copy answers with the original result', async () => {
    const wallet = await instance(0).wallet('100.00');
    const bet = wager(wallet, { money: BRL('10.00') });

    const responses = await Promise.all(Array.from({ length: 50 }, (_, i) => instance(i).submit(bet)));

    expect(responses.map((res) => res.status)).toEqual(Array(50).fill(200));
    expect(new Set(responses.map((res) => res.body.transactionId)).size).toBe(1);
    expect(responses.filter((res) => !res.body.idempotentReplay)).toHaveLength(1);
    expect(responses.every((res) => res.body.balance.amount === '90.00')).toBe(true);
    expect(await walletState(wallet.id)).toEqual({ balance: '90.00', version: 2, debits: 1 });
  });
});

describe('different wallets', () => {
  it('keeps every wallet correct when bets for many wallets run at the same time', async () => {
    const wallets = await Promise.all(Array.from({ length: 10 }, (_, i) => instance(i).wallet('30.00')));

    await Promise.all(
      wallets.flatMap((wallet, w) => Array.from({ length: 5 }, (_, b) => instance(w + b).submit(wager(wallet, { money: BRL('10.00') })))),
    );

    for (const wallet of wallets) expect(await walletState(wallet.id)).toEqual({ balance: '0.00', version: 4, debits: 3 });
  });

  it('serves a bet on one wallet while another wallet is locked, and answers 503 TRANSIENT_FAILURE once the lock wait times out', async () => {
    const [busy, free] = await Promise.all([instance(0).wallet('100.00'), instance(1).wallet('100.00')]);
    const holder = await apps.db.sql.reserve();
    try {
      await holder`BEGIN`;
      await holder`SELECT id FROM wallets WHERE id = ${busy.id} FOR NO KEY UPDATE`;

      const blocked = instance(0).submit(wager(busy));
      const served = await instance(1).submit(wager(free));

      expect(served.status).toBe(200);
      const timedOut = await blocked;
      expect(timedOut.status).toBe(503);
      expect(timedOut.body.failureCode).toBe('TRANSIENT_FAILURE');
      expect(timedOut.headers.get('retry-after')).toBe('1');
    } finally {
      await holder`ROLLBACK`;
      holder.release();
    }
    expect(await walletState(busy.id)).toEqual({ balance: '100.00', version: 1, debits: 0 });
  }, 15_000);
});
