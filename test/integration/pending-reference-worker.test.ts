import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import type { MikroORM } from '@mikro-orm/postgresql';
import { createOrm } from '../../src/infrastructure/persistence/orm.ts';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work.ts';
import { SystemClock, UuidV7IdGenerator } from '../../src/infrastructure/system.ts';
import { ProcessPendingReferences } from '../../src/application/use-cases/process-pending-references.ts';
import { PENDING_REFERENCE_POLL_INTERVAL_ENV } from '../../src/infrastructure/workers/pending-reference-worker.ts';
import { DEFAULT_PENDING_REFERENCE_POLICY } from '../../src/domain/wager-transaction.ts';
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

const MAX_ATTEMPTS = 3;
const POLICY = { ...DEFAULT_PENDING_REFERENCE_POLICY, maxAttempts: MAX_ATTEMPTS };

let apps: TestApps;
let api: ApiClient;
// Each worker has its own ORM and pool, like a separate instance would.
let orms: MikroORM[];
let workers: ProcessPendingReferences[];

beforeAll(async () => {
  process.env[PENDING_REFERENCE_POLL_INTERVAL_ENV] = '0';
  apps = await startTestApps('pending_reference_worker');
  api = apps.apis[0]!;
  orms = await Promise.all([createOrm(apps.db.url), createOrm(apps.db.url)]);
  workers = orms.map((orm) => new ProcessPendingReferences(new MikroOrmUnitOfWork(orm), new SystemClock(), new UuidV7IdGenerator(), { policy: POLICY }));
});

afterEach(async () => {
  await expectMoneyInvariants(apps.db);
});

afterAll(async () => {
  delete process.env[PENDING_REFERENCE_POLL_INTERVAL_ENV];
  await Promise.all(orms.map((orm) => orm.close(true)));
  await apps.close();
});

const worker = () => workers[0]!;

const reversalOf = (wallet: WalletRef, reference: WagerBody, kind: string, overrides: Record<string, unknown> = {}) =>
  wager(wallet, { kind, money: reference.money, referenceExternalTransactionId: reference.externalTransactionId, ...overrides });

async function submitPending(wallet: WalletRef, body: WagerBody): Promise<string> {
  const res = await api.submit(body);
  expect(res.status).toBe(202);
  return res.body.transactionId as string;
}

async function transactionRow(id: string) {
  const [row] = await apps.db.sql`
    SELECT status, failure_code, retry_attempts, next_retry_at, reference_transaction_id,
           EXTRACT(EPOCH FROM (next_retry_at - now()))::float AS seconds_until_retry
    FROM wager_transactions WHERE id = ${id}`;
  return row as {
    status: string;
    failure_code: string | null;
    retry_attempts: number;
    next_retry_at: Date | null;
    reference_transaction_id: string | null;
    seconds_until_retry: number | null;
  };
}

async function ledgerEntriesOf(transactionId: string) {
  const [row] = await apps.db.sql`SELECT count(*)::int AS count FROM wallet_ledger_entries WHERE transaction_id = ${transactionId}`;
  return row.count as number;
}

const makeDue = (id: string) => apps.db.sql`UPDATE wager_transactions SET next_retry_at = now() - interval '1 second' WHERE id = ${id}`;

async function balanceOf(wallet: WalletRef) {
  return (await api.get(`/wallets/${wallet.id}`)).body.balance;
}

describe('a reversal that arrives before its BET', () => {
  const cases = [
    { kind: 'ROLLBACK', money: BRL('10.00'), balanceAfter: '100.00' },
    { kind: 'REFUND', money: BRL('10.00'), balanceAfter: '100.00' },
    { kind: 'WIN', money: BRL('25.00'), balanceAfter: '115.00' },
  ];

  for (const { kind, money, balanceAfter } of cases) {
    it(`applies a ${kind} once the BET lands, with a single ledger entry and the balance the pair implies`, async () => {
      const wallet = await api.wallet('100.00');
      const lateBet = wager(wallet, { money: BRL('10.00') });
      const body = reversalOf(wallet, lateBet, kind, { money });
      const pendingId = await submitPending(wallet, body);

      expect(await worker().runOnce()).toMatchObject({ retried: 1, processed: 0 });
      expect((await transactionRow(pendingId)).status).toBe('PENDING_REFERENCE');

      const bet = await api.submit(lateBet);
      expect(bet.status).toBe(200);
      await makeDue(pendingId);
      expect(await worker().runOnce()).toMatchObject({ processed: 1, errors: 0 });

      expect(await transactionRow(pendingId)).toMatchObject({ status: 'PROCESSED', reference_transaction_id: bet.body.transactionId });
      expect(await ledgerEntriesOf(pendingId)).toBe(1);
      expect(await balanceOf(wallet)).toEqual(BRL(balanceAfter));
      expect(await eventTypesOf(apps.db, pendingId)).toEqual([
        'WagerTransactionPendingReference',
        'WagerTransactionProcessed',
        'WalletBalanceChanged',
      ]);

      // Done is done: another tick finds nothing, and the provider's replay now sees the progressed state (plan 4.4).
      expect(await worker().runOnce()).toMatchObject({ processed: 0, retried: 0 });
      expect(await ledgerEntriesOf(pendingId)).toBe(1);
      const replay = await api.submit(body);
      expect(replay.status).toBe(200);
      expect(replay.body).toMatchObject({ status: 'PROCESSED', balance: BRL(balanceAfter), idempotentReplay: true });
    });
  }

  it('waits for next_retry_at between attempts and doubles the wait every time the reference is still missing', async () => {
    const wallet = await api.wallet('100.00');
    const pendingId = await submitPending(wallet, reversalOf(wallet, wager(wallet), 'ROLLBACK'));

    expect(await worker().runOnce()).toMatchObject({ retried: 1 });
    const first = await transactionRow(pendingId);
    expect(first.retry_attempts).toBe(1);
    expect(first.seconds_until_retry).toBeGreaterThan(3);
    expect(first.seconds_until_retry).toBeLessThanOrEqual(4);

    expect(await worker().runOnce()).toMatchObject({ retried: 0 });
    expect((await transactionRow(pendingId)).retry_attempts).toBe(1);

    await makeDue(pendingId);
    expect(await worker().runOnce()).toMatchObject({ retried: 1 });
    const second = await transactionRow(pendingId);
    expect(second.retry_attempts).toBe(2);
    expect(second.seconds_until_retry).toBeGreaterThan(7);
    expect(second.seconds_until_retry).toBeLessThanOrEqual(8);
  });

  it('rejects a pending REFUND whose BET was already reversed by a ROLLBACK that overtook it, instead of crediting twice', async () => {
    const wallet = await api.wallet('100.00');
    const lateBet = wager(wallet, { money: BRL('10.00') });
    const pendingId = await submitPending(wallet, reversalOf(wallet, lateBet, 'REFUND'));
    expect((await api.submit(lateBet)).status).toBe(200);
    const rollback = await api.submit(reversalOf(wallet, lateBet, 'ROLLBACK'));
    expect(rollback.status).toBe(200);
    expect(await balanceOf(wallet)).toEqual(BRL('100.00'));

    await makeDue(pendingId);
    expect(await worker().runOnce()).toMatchObject({ rejected: 1, processed: 0, errors: 0 });

    expect(await transactionRow(pendingId)).toMatchObject({ status: 'REJECTED', failure_code: 'REFERENCE_ALREADY_REVERSED' });
    expect(await ledgerEntriesOf(pendingId)).toBe(0);
    expect(await balanceOf(wallet)).toEqual(BRL('100.00'));
    expect(await eventTypesOf(apps.db, pendingId)).toEqual(['WagerTransactionPendingReference', 'WagerTransactionRejected']);
  });
});

describe('giving up on a reference that never arrives', () => {
  it('rejects with REFERENCE_NOT_FOUND and announces it when the attempts cap is reached', async () => {
    const wallet = await api.wallet('100.00');
    const pendingId = await submitPending(wallet, reversalOf(wallet, wager(wallet), 'ROLLBACK'));

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      await makeDue(pendingId);
      expect(await worker().runOnce()).toMatchObject({ retried: 1, rejected: 0 });
    }
    expect((await transactionRow(pendingId)).retry_attempts).toBe(MAX_ATTEMPTS);

    await makeDue(pendingId);
    expect(await worker().runOnce()).toMatchObject({ rejected: 1, retried: 0 });

    expect(await transactionRow(pendingId)).toMatchObject({ status: 'REJECTED', failure_code: 'REFERENCE_NOT_FOUND' });
    expect(await ledgerEntriesOf(pendingId)).toBe(0);
    expect(await balanceOf(wallet)).toEqual(BRL('100.00'));
    expect(await eventTypesOf(apps.db, pendingId)).toEqual(['WagerTransactionPendingReference', 'WagerTransactionRejected']);
    expect(await worker().runOnce()).toMatchObject({ rejected: 0, retried: 0 });
  });

  it('rejects with REFERENCE_NOT_FOUND once the transaction is older than the TTL, whatever the attempt count', async () => {
    const wallet = await api.wallet('100.00');
    const body = reversalOf(wallet, wager(wallet), 'REFUND');
    const pendingId = await submitPending(wallet, body);
    await apps.db.sql`UPDATE wager_transactions SET created_at = now() - interval '25 hours' WHERE id = ${pendingId}`;

    expect(await worker().runOnce()).toMatchObject({ rejected: 1, retried: 0 });

    expect(await transactionRow(pendingId)).toMatchObject({ status: 'REJECTED', failure_code: 'REFERENCE_NOT_FOUND', retry_attempts: 0 });
    const replay = await api.submit(body);
    expect(replay.status).toBe(422);
    expect(replay.body).toMatchObject({ status: 'REJECTED', failureCode: 'REFERENCE_NOT_FOUND', idempotentReplay: true });
  });

  it('applies a reference that lands on the last allowed attempt rather than giving up first', async () => {
    const wallet = await api.wallet('100.00');
    const lateBet = wager(wallet, { money: BRL('10.00') });
    const pendingId = await submitPending(wallet, reversalOf(wallet, lateBet, 'ROLLBACK'));
    await apps.db.sql`UPDATE wager_transactions SET retry_attempts = ${MAX_ATTEMPTS} WHERE id = ${pendingId}`;
    expect((await api.submit(lateBet)).status).toBe(200);

    expect(await worker().runOnce()).toMatchObject({ processed: 1, rejected: 0 });
    expect((await transactionRow(pendingId)).status).toBe('PROCESSED');
    expect(await balanceOf(wallet)).toEqual(BRL('100.00'));
  });
});

describe('several workers over the same pending queue', () => {
  /** Runs `requests` while a FOR SHARE lock on the wallet stalls every write lock, and lets go once `blocked` sessions wait on a lock. */
  async function underSharedWalletLock<T>(walletId: string, blocked: number, requests: () => Promise<T>): Promise<T> {
    const holder = await apps.db.sql.reserve();
    try {
      await holder`BEGIN`;
      await holder`SELECT id FROM wallets WHERE id = ${walletId} FOR SHARE`;
      const pending = requests();
      for (let waiting = 0; waiting < blocked; await Bun.sleep(10)) {
        const [row] = await apps.db.sql`
          SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
        waiting = row.waiting;
      }
      await holder`COMMIT`;
      return await pending;
    } finally {
      holder.release();
    }
  }

  async function twoPendingRollbacksWithBetsLanded(wallet: WalletRef): Promise<[string, string]> {
    const betA = wager(wallet, { money: BRL('10.00') });
    const betB = wager(wallet, { money: BRL('20.00') });
    const a = await submitPending(wallet, reversalOf(wallet, betA, 'ROLLBACK'));
    const b = await submitPending(wallet, reversalOf(wallet, betB, 'ROLLBACK'));
    expect((await api.submit(betA)).status).toBe(200);
    expect((await api.submit(betB)).status).toBe(200);
    expect(await balanceOf(wallet)).toEqual(BRL('70.00'));
    return [a, b];
  }

  it('skips a pending transaction another worker is holding and processes the next one without waiting', async () => {
    const wallet = await api.wallet('100.00');
    const [a, b] = await twoPendingRollbacksWithBetsLanded(wallet);

    const holder = await apps.db.sql.reserve();
    try {
      await holder`BEGIN`;
      await holder`SELECT id FROM wager_transactions WHERE id = ${a} FOR NO KEY UPDATE`;
      const started = Date.now();
      expect(await worker().runOnce()).toMatchObject({ processed: 1, errors: 0 });
      expect(Date.now() - started).toBeLessThan(1_000);
      expect((await transactionRow(a)).status).toBe('PENDING_REFERENCE');
      expect((await transactionRow(b)).status).toBe('PROCESSED');
      await holder`COMMIT`;
    } finally {
      holder.release();
    }

    expect(await worker().runOnce()).toMatchObject({ processed: 1 });
    expect((await transactionRow(a)).status).toBe('PROCESSED');
    expect(await balanceOf(wallet)).toEqual(BRL('100.00'));
  });

  it('lets two workers racing on the same wallet apply each pending transaction exactly once, without colliding', async () => {
    const wallet = await api.wallet('100.00');
    const [a, b] = await twoPendingRollbacksWithBetsLanded(wallet);

    const runs = await underSharedWalletLock(wallet.id, 2, () => Promise.all(workers.map((w) => w.runOnce())));

    expect(runs.map((run) => run.processed)).toEqual([1, 1]);
    expect(runs.map((run) => run.errors)).toEqual([0, 0]);
    expect(await ledgerEntriesOf(a)).toBe(1);
    expect(await ledgerEntriesOf(b)).toBe(1);
    expect(await balanceOf(wallet)).toEqual(BRL('100.00'));
  });
});

describe('the scheduled worker inside the app', () => {
  let scheduled: TestApps;

  beforeAll(async () => {
    process.env[PENDING_REFERENCE_POLL_INTERVAL_ENV] = '50';
    scheduled = await startTestApps('pending_reference_scheduled');
    process.env[PENDING_REFERENCE_POLL_INTERVAL_ENV] = '0';
  });

  afterAll(async () => {
    await scheduled.close();
  });

  it('applies a pending ROLLBACK on its own timer once the BET lands, with nobody calling it', async () => {
    const client = scheduled.apis[0]!;
    const wallet = await client.wallet('100.00');
    const lateBet = wager(wallet, { money: BRL('10.00') });
    const pending = await client.submit(reversalOf(wallet, lateBet, 'ROLLBACK'));
    expect(pending.status).toBe(202);
    expect((await client.submit(lateBet)).status).toBe(200);
    // A tick between the two submits already backed the row off by seconds; bring it forward so the test stays fast.
    await scheduled.db.sql`UPDATE wager_transactions SET next_retry_at = NULL WHERE id = ${pending.body.transactionId}`;

    let status = 'PENDING_REFERENCE';
    for (const deadline = Date.now() + 3_000; status !== 'PROCESSED' && Date.now() < deadline; await Bun.sleep(25)) {
      const [row] = await scheduled.db.sql`SELECT status FROM wager_transactions WHERE id = ${pending.body.transactionId}`;
      status = row.status;
    }
    expect(status).toBe('PROCESSED');
    expect((await client.get(`/wallets/${wallet.id}`)).body.balance).toEqual(BRL('100.00'));
    await expectMoneyInvariants(scheduled.db);
  });
});
