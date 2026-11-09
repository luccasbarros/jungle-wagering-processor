import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../../src/app.module.ts';
import { Metrics } from '../../src/application/ports/metrics.ts';
import { RECONCILIATION_DIVERGENCE_TOTAL } from '../../src/application/use-cases/reconcile-wallet.ts';
import type { InProcessMetrics } from '../../src/infrastructure/in-process-metrics.ts';
import { createTestDatabase, type TestDatabase } from './support/test-database.ts';
import { apiClient, BRL, expectMoneyInvariants, wager, type ApiClient, type WalletRef } from './support/test-app.ts';

let db: TestDatabase;
let app: INestApplication;
let api: ApiClient;
let metrics: InProcessMetrics;

beforeAll(async () => {
  db = await createTestDatabase('wallet_queries_api');
  app = await createApp({ databaseUrl: db.url });
  await app.listen(0);
  api = apiClient(await app.getUrl());
  metrics = app.get(Metrics) as InProcessMetrics;
});

afterEach(async () => {
  await expectMoneyInvariants(db);
});

afterAll(async () => {
  await app.close();
  await db.drop();
});

const ledgerPath = (walletId: string, query: Record<string, string> = {}) => {
  const params = new URLSearchParams(query).toString();
  return `/wallets/${walletId}/ledger${params ? `?${params}` : ''}`;
};

const reconcile = (walletId: string, headers: Record<string, string> = {}) =>
  api.postRaw(`/wallets/${walletId}/reconciliation`, '', headers);

const cursorOf = (raw: string) => Buffer.from(raw).toString('base64url');

async function bet(wallet: WalletRef, amount: string): Promise<void> {
  const res = await api.submit(wager(wallet, { money: BRL(amount) }));
  expect(res.status).toBe(200);
}

async function waitForLockWaiters(count: number): Promise<void> {
  for (let waiting = 0; waiting < count; await Bun.sleep(10)) {
    const [row] = await db.sql`
      SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    waiting = row.waiting;
  }
}

describe('GET /wallets/:walletId/ledger', () => {
  it('lists entries newest first and hands out an opaque cursor until the oldest entry, then a null nextCursor', async () => {
    const wallet = await api.wallet('100.00');
    for (let i = 0; i < 3; i++) await bet(wallet, '10.00');

    const first = await api.get(ledgerPath(wallet.id, { limit: '3' }));
    expect(first.status).toBe(200);
    expect(first.body.entries.map((e: any) => e.balanceAfter.amount)).toEqual(['70.00', '80.00', '90.00']);
    expect(first.body.entries[0]).toEqual({
      id: expect.any(String),
      transactionId: expect.any(String),
      direction: 'DEBIT',
      money: BRL('10.00'),
      balanceBefore: BRL('80.00'),
      balanceAfter: BRL('70.00'),
      createdAt: expect.any(String),
    });
    expect(first.body.nextCursor).toEqual(expect.any(String));

    const last = await api.get(ledgerPath(wallet.id, { limit: '3', cursor: first.body.nextCursor }));
    expect(last.status).toBe(200);
    expect(last.body.entries.map((e: any) => [e.direction, e.balanceBefore.amount, e.balanceAfter.amount])).toEqual([
      ['CREDIT', '0.00', '100.00'],
    ]);
    expect(last.body.nextCursor).toBeNull();
  });

  // Newest first is where offset pagination breaks: every insert at the head shifts the next offset page onto rows already returned.
  it('walks 120 entries in pages of 50 while bets keep committing, returning every entry that existed exactly once', async () => {
    const wallet = await api.wallet('1000.00');
    await Promise.all(Array.from({ length: 119 }, () => bet(wallet, '1.00')));

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const [page] = await Promise.all([
        api.get(ledgerPath(wallet.id, cursor ? { cursor } : {})),
        Promise.all(Array.from({ length: 3 }, () => bet(wallet, '1.00'))),
      ]);
      expect(page.status).toBe(200);
      if (pages === 0) expect(page.body.entries).toHaveLength(50);
      seen.push(...page.body.entries.map((e: any) => e.id));
      cursor = page.body.nextCursor ?? undefined;
      pages++;
      await Promise.all(Array.from({ length: 5 }, () => bet(wallet, '1.00')));
    } while (cursor);

    const expected = await db.sql`
      SELECT id FROM wallet_ledger_entries
      WHERE wallet_id = ${wallet.id} AND seq <= (SELECT seq FROM wallet_ledger_entries WHERE id = ${seen[0]})
      ORDER BY seq DESC`;
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual(expected.map((row: { id: string }) => row.id));
    expect(seen.length).toBeGreaterThanOrEqual(120);
  }, 30_000);

  it('accepts a limit of 200 and rejects limits outside 1..200 or not an integer with 400 INVALID_PAYLOAD', async () => {
    const wallet = await api.wallet('10.00');

    expect((await api.get(ledgerPath(wallet.id, { limit: '200' }))).status).toBe(200);
    for (const limit of ['0', '201', '-1', 'abc', '1.5', '']) {
      const res = await api.get(ledgerPath(wallet.id, { limit }));
      expect({ limit, status: res.status, failureCode: res.body.failureCode }).toEqual({ limit, status: 400, failureCode: 'INVALID_PAYLOAD' });
    }
  });

  it('rejects a cursor that does not decode to a ledger position with 400 INVALID_PAYLOAD instead of a database error', async () => {
    const wallet = await api.wallet('10.00');

    for (const cursor of ['%%%', cursorOf('abc'), cursorOf('0'), cursorOf('-5'), cursorOf('1.5'), cursorOf('9223372036854775808')]) {
      const res = await api.get(ledgerPath(wallet.id, { cursor }));
      expect({ cursor, status: res.status, failureCode: res.body.failureCode }).toEqual({ cursor, status: 400, failureCode: 'INVALID_PAYLOAD' });
    }
  });

  it('answers 404 WALLET_NOT_FOUND for an unknown wallet and 400 INVALID_PAYLOAD for a walletId that is not a UUID', async () => {
    const unknown = await api.get(ledgerPath(crypto.randomUUID()));
    expect(unknown.status).toBe(404);
    expect(unknown.body.failureCode).toBe('WALLET_NOT_FOUND');

    const malformed = await api.get(ledgerPath('not-a-uuid'));
    expect(malformed.status).toBe(400);
    expect(malformed.body.failureCode).toBe('INVALID_PAYLOAD');
  });
});

describe('POST /wallets/:walletId/reconciliation', () => {
  it('reports a wallet whose balance matches its ledger as consistent without counting a divergence', async () => {
    const wallet = await api.wallet('100.00');
    await bet(wallet, '25.00');
    await bet(wallet, '10.00');
    const divergencesBefore = metrics.count(RECONCILIATION_DIVERGENCE_TOTAL);

    const res = await reconcile(wallet.id);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      walletId: wallet.id,
      storedBalance: BRL('65.00'),
      calculatedBalance: BRL('65.00'),
      difference: BRL('0.00'),
      consistent: true,
      checkedEntries: 3,
    });
    expect(metrics.count(RECONCILIATION_DIVERGENCE_TOTAL)).toBe(divergencesBefore);
  });

  it('reports a wallet opened at zero, which has no ledger entries, as consistent at 0.00', async () => {
    const res = await api.openWallet(BRL('0.00'));

    const reconciliation = await reconcile(res.body.id);

    expect(reconciliation.status).toBe(200);
    expect(reconciliation.body).toMatchObject({ calculatedBalance: BRL('0.00'), difference: BRL('0.00'), consistent: true, checkedEntries: 0 });
  });

  it('flags a balance edited behind the ledger with consistent:false, the signed difference, a warn log and the divergence counter, and leaves the stored balance as it found it', async () => {
    const wallet = await api.wallet('100.00');
    await db.sql`UPDATE wallets SET balance = balance + 5.00 WHERE id = ${wallet.id}`;
    const divergencesBefore = metrics.count(RECONCILIATION_DIVERGENCE_TOTAL);
    const warn = spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const res = await reconcile(wallet.id, { 'x-correlation-id': 'reconcile-1' });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        walletId: wallet.id,
        storedBalance: BRL('105.00'),
        calculatedBalance: BRL('100.00'),
        difference: BRL('5.00'),
        consistent: false,
        checkedEntries: 1,
      });
      expect(metrics.count(RECONCILIATION_DIVERGENCE_TOTAL)).toBe(divergencesBefore + 1);
      expect(warn.mock.calls.map(([line]) => JSON.parse(String(line)))).toEqual([
        {
          level: 'warn',
          msg: 'reconciliation divergence',
          correlationId: 'reconcile-1',
          walletId: wallet.id,
          difference: BRL('5.00'),
          checkedEntries: 1,
        },
      ]);

      const [stored] = await db.sql`SELECT balance::text AS balance, version FROM wallets WHERE id = ${wallet.id}`;
      expect(stored).toEqual({ balance: '105.00', version: 1 });
      expect((await reconcile(wallet.id)).body.consistent).toBe(false);
    } finally {
      warn.mockRestore();
      await db.sql`UPDATE wallets SET balance = 100.00 WHERE id = ${wallet.id}`;
    }
  });

  // The test holds the ledger table so the reconciliation is parked between "read the wallet" and "sum the ledger", and books a debit right there.
  it('never reports a divergence for a debit that commits while the reconciliation is waiting to read the ledger', async () => {
    const wallet = await api.wallet('100.00');
    const transactionId = crypto.randomUUID();
    const holder = await db.sql.reserve();
    try {
      await holder`BEGIN`;
      await holder`LOCK TABLE wallet_ledger_entries IN ACCESS EXCLUSIVE MODE`;
      const pending = reconcile(wallet.id);
      await waitForLockWaiters(1);

      await holder`
        INSERT INTO wager_transactions (id, provider_id, external_transaction_id, idempotency_key, payload_hash, wallet_id, player_id,
          round_id, game_id, kind, status, amount, currency, observed_balance, observed_balance_currency, created_at, processed_at)
        VALUES (${transactionId}, 'provider-a', ${transactionId}, ${`provider-a:${transactionId}`}, 'raw', ${wallet.id}, ${wallet.playerId},
          'round-1', 'fortune-chimp', 'BET', 'PROCESSED', 10.00, 'BRL', 90.00, 'BRL', now(), now())`;
      await holder`
        INSERT INTO wallet_ledger_entries (id, wallet_id, transaction_id, direction, amount, balance_before, balance_after, currency, created_at)
        VALUES (${crypto.randomUUID()}, ${wallet.id}, ${transactionId}, 'DEBIT', 10.00, 100.00, 90.00, 'BRL', now())`;
      await holder`UPDATE wallets SET balance = 90.00, version = version + 1 WHERE id = ${wallet.id}`;
      await holder`
        INSERT INTO outbox_messages (id, aggregate_id, event_type, payload, occurred_at)
        SELECT gen_random_uuid(), ${wallet.id}, event_type, jsonb_build_object('data', jsonb_build_object('transactionId', ${transactionId}::text)), now()
        FROM unnest(ARRAY['WalletBalanceChanged', 'WagerTransactionProcessed']) AS event_type`;
      await holder`COMMIT`;

      const res = await pending;
      expect(res.body).toMatchObject({ storedBalance: BRL('90.00'), calculatedBalance: BRL('90.00'), consistent: true, checkedEntries: 2 });
    } finally {
      holder.release();
    }
  });

  it('answers 404 WALLET_NOT_FOUND for an unknown wallet', async () => {
    const res = await reconcile(crypto.randomUUID());

    expect(res.status).toBe(404);
    expect(res.body.failureCode).toBe('WALLET_NOT_FOUND');
  });
});
