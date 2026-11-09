import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work.ts';
import { SystemClock, UuidV7IdGenerator } from '../../src/infrastructure/system.ts';
import { UnitOfWork, type Repositories } from '../../src/application/ports/unit-of-work.ts';
import { ProcessPendingReferences } from '../../src/application/use-cases/process-pending-references.ts';
import { PENDING_REFERENCE_POLL_INTERVAL_ENV } from '../../src/infrastructure/workers/pending-reference-worker.ts';
import { DEFAULT_PENDING_REFERENCE_POLICY } from '../../src/domain/wager-transaction.ts';
import { PrometheusMetrics } from '../../src/infrastructure/observability/prometheus-metrics.ts';
import { BRL, eventTypesOf, startTestApps, wager, type ApiClient, type TestApps } from './support/test-app.ts';

const MAX_ATTEMPTS = 1;

/** Real Postgres and real repositories; only the ledger append is replaced by a planted failure, so the apply step blows up after the locks. */
class LedgerFaultUnitOfWork extends UnitOfWork {
  constructor(private readonly real: UnitOfWork) {
    super();
  }

  transaction<T>(work: (r: Repositories) => Promise<T>): Promise<T> {
    return this.real.transaction((r) =>
      work({
        ...r,
        ledger: {
          ...r.ledger,
          append: async () => {
            throw new Error('planted ledger failure');
          },
        },
      }),
    );
  }

  read<T>(work: (r: Repositories) => Promise<T>): Promise<T> {
    return this.real.read(work);
  }
}

let apps: TestApps;
let api: ApiClient;
let worker: ProcessPendingReferences;
const metrics = new PrometheusMetrics({ outboxLagSeconds: async () => 0, deadLetterDepth: async () => 0 });

beforeAll(async () => {
  process.env[PENDING_REFERENCE_POLL_INTERVAL_ENV] = '0';
  apps = await startTestApps('pending_reference_failure');
  api = apps.apis[0]!;
  const uow = new LedgerFaultUnitOfWork(new MikroOrmUnitOfWork(apps.db.orm));
  worker = new ProcessPendingReferences(uow, new SystemClock(), new UuidV7IdGenerator(), metrics, {
    policy: { ...DEFAULT_PENDING_REFERENCE_POLICY, maxAttempts: MAX_ATTEMPTS },
  });
});

afterAll(async () => {
  delete process.env[PENDING_REFERENCE_POLL_INTERVAL_ENV];
  await apps.close();
});

async function transactionRow(id: string) {
  const [row] = await apps.db.sql`SELECT status, failure_code, retry_attempts, next_retry_at FROM wager_transactions WHERE id = ${id}`;
  return row as { status: string; failure_code: string | null; retry_attempts: number; next_retry_at: Date | null };
}

// FAILED is excluded from the shared money invariants on purpose: spec 11 defines no event for an infrastructure dead end.
describe('a pending transaction whose attempt keeps blowing up', () => {
  it('is backed off instead of being retried every tick, and ends FAILED PERMANENT_FAILURE with the money untouched once the policy is spent', async () => {
    const wallet = await api.wallet('100.00');
    const lateBet = wager(wallet, { money: BRL('10.00') });
    const pending = await api.submit(wager(wallet, { kind: 'ROLLBACK', money: lateBet.money, referenceExternalTransactionId: lateBet.externalTransactionId }));
    expect(pending.status).toBe(202);
    expect((await api.submit(lateBet)).status).toBe(200);
    const id = pending.body.transactionId as string;

    expect(await worker.runOnce()).toMatchObject({ errors: 1, retried: 1, processed: 0, failed: 0 });
    const backedOff = await transactionRow(id);
    expect(backedOff).toMatchObject({ status: 'PENDING_REFERENCE', retry_attempts: 1 });
    expect(backedOff.next_retry_at!.getTime()).toBeGreaterThan(Date.now());

    expect(await worker.runOnce()).toMatchObject({ errors: 0 });

    await apps.db.sql`UPDATE wager_transactions SET next_retry_at = now() - interval '1 second' WHERE id = ${id}`;
    expect(await worker.runOnce()).toMatchObject({ errors: 1, retried: 0, failed: 1 });

    expect(await transactionRow(id)).toMatchObject({ status: 'FAILED', failure_code: 'PERMANENT_FAILURE', retry_attempts: MAX_ATTEMPTS });
    const [ledger] = await apps.db.sql`SELECT count(*)::int AS count FROM wallet_ledger_entries WHERE transaction_id = ${id}`;
    expect(ledger.count).toBe(0);
    expect((await api.get(`/wallets/${wallet.id}`)).body.balance).toEqual(BRL('90.00'));
    expect(await eventTypesOf(apps.db, id)).toEqual(['WagerTransactionPendingReference']);
    const exposition = await metrics.registry.metrics();
    expect(exposition).toContain('retries_total{kind="pending_reference"} 1');
    expect(exposition).toContain('pending_reference_exhausted_total{status="FAILED"} 1');
    expect(exposition).toContain('wager_transactions_total{status="FAILED"} 1');
  });
});

describe('replaying a FAILED transaction', () => {
  it('answers 422 with the stored FAILED result and PERMANENT_FAILURE, never a 500 that invites a retry', async () => {
    const wallet = await api.wallet('100.00');
    const lateBet = wager(wallet, { money: BRL('10.00') });
    const rollback = wager(wallet, { kind: 'ROLLBACK', money: lateBet.money, referenceExternalTransactionId: lateBet.externalTransactionId });
    const pending = await api.submit(rollback);
    expect(pending.status).toBe(202);
    expect((await api.submit(lateBet)).status).toBe(200);
    expect(await worker.runOnce()).toMatchObject({ errors: 1, retried: 1 });
    await apps.db.sql`UPDATE wager_transactions SET next_retry_at = now() - interval '1 second' WHERE id = ${pending.body.transactionId}`;
    expect(await worker.runOnce()).toMatchObject({ failed: 1 });

    const replay = await api.submit(rollback);

    expect(replay.status).toBe(422);
    expect(replay.body).toEqual({
      transactionId: pending.body.transactionId,
      status: 'FAILED',
      failureCode: 'PERMANENT_FAILURE',
      balance: BRL('100.00'),
      idempotentReplay: true,
    });
  });
});
