import { expect } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../../../src/app.module.ts';
import { createTestDatabase, type TestDatabase } from './test-database.ts';

export interface TestApps {
  db: TestDatabase;
  /** One API client per app instance; every instance has its own connection pool. */
  apis: ApiClient[];
  close(): Promise<void>;
}

export async function startTestApps(name: string, instances = 1): Promise<TestApps> {
  const db = await createTestDatabase(name);
  const apps: INestApplication[] = [];
  for (let i = 0; i < instances; i++) {
    const app = await createApp({ databaseUrl: db.url });
    await app.listen(0);
    apps.push(app);
  }
  const apis = await Promise.all(apps.map(async (app) => apiClient(await app.getUrl())));
  return {
    db,
    apis,
    async close() {
      await Promise.all(apps.map((app) => app.close()));
      await db.drop();
    },
  };
}

export interface ApiResponse {
  status: number;
  headers: Headers;
  body: any;
}

export const BRL = (amount: string) => ({ amount, currency: 'BRL' });

export interface WalletRef {
  id: string;
  playerId: string;
}

export type WagerBody = Record<string, unknown> & { providerId: string; externalTransactionId: string };

export function wager(wallet: WalletRef, overrides: Record<string, unknown> = {}): WagerBody {
  return {
    providerId: 'provider-a',
    externalTransactionId: crypto.randomUUID(),
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-1',
    gameId: 'fortune-chimp',
    kind: 'BET',
    money: BRL('10.00'),
    ...overrides,
  };
}

export const defaultKey = (body: WagerBody) => `${body.providerId}:${body.externalTransactionId}`;

export type ApiClient = ReturnType<typeof apiClient>;

export function apiClient(baseUrl: string) {
  async function call(method: string, path: string, init: { body?: string; headers?: Record<string, string> } = {}): Promise<ApiResponse> {
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...init.headers },
      body: init.body,
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : undefined };
  }

  return {
    openWallet(initialBalance: unknown, playerId: string = crypto.randomUUID()): Promise<ApiResponse> {
      return call('POST', '/wallets', { body: JSON.stringify({ playerId, initialBalance }) });
    },
    /** Opens a wallet and fails the test unless it was created. */
    async wallet(amount: string, playerId?: string): Promise<WalletRef> {
      const res = await this.openWallet(BRL(amount), playerId);
      expect(res.status).toBe(201);
      return { id: res.body.id, playerId: res.body.playerId };
    },
    submit(body: WagerBody, key: string | null = defaultKey(body), headers: Record<string, string> = {}): Promise<ApiResponse> {
      const idempotency: Record<string, string> = key === null ? {} : { 'idempotency-key': key };
      return call('POST', '/wagering/transactions', { body: JSON.stringify(body), headers: { ...idempotency, ...headers } });
    },
    postRaw(path: string, body: string, headers: Record<string, string> = {}): Promise<ApiResponse> {
      return call('POST', path, { body, headers });
    },
    get(path: string): Promise<ApiResponse> {
      return call('GET', path);
    },
  };
}

const EVENT_FOR_STATUS = `CASE t.status
  WHEN 'PROCESSED' THEN 'WagerTransactionProcessed'
  WHEN 'REJECTED' THEN 'WagerTransactionRejected'
  WHEN 'PENDING_REFERENCE' THEN 'WagerTransactionPendingReference' END`;

/** Balance equals the ledger sum; version is 1 + non-OPENING movements; one outbox event per ledger entry and per decided transaction. */
export async function expectMoneyInvariants(db: TestDatabase): Promise<void> {
  const drift = await db.sql`
    SELECT w.id, w.balance::text AS balance, COALESCE(l.total, 0)::text AS ledger_total, w.version, COALESCE(l.movements, 0)::int AS movements
    FROM wallets w
    LEFT JOIN (
      SELECT e.wallet_id,
             SUM(CASE e.direction WHEN 'CREDIT' THEN e.amount ELSE -e.amount END) AS total,
             COUNT(*) FILTER (WHERE t.kind <> 'OPENING') AS movements
      FROM wallet_ledger_entries e JOIN wager_transactions t ON t.id = e.transaction_id
      GROUP BY e.wallet_id
    ) l ON l.wallet_id = w.id
    WHERE w.balance <> COALESCE(l.total, 0) OR w.version <> 1 + COALESCE(l.movements, 0)`;
  expect(drift).toEqual([]);

  const entriesWithoutOneBalanceEvent = await db.sql`
    SELECT e.transaction_id FROM wallet_ledger_entries e
    WHERE (SELECT count(*) FROM outbox_messages o
           WHERE o.event_type = 'WalletBalanceChanged' AND o.payload -> 'data' ->> 'transactionId' = e.transaction_id::text) <> 1`;
  expect(entriesWithoutOneBalanceEvent).toEqual([]);

  const transactionsWithoutOneStatusEvent = await db.sql.unsafe(`
    SELECT t.id, t.status FROM wager_transactions t
    WHERE (SELECT count(*) FROM outbox_messages o
           WHERE o.payload -> 'data' ->> 'transactionId' = t.id::text AND o.event_type = ${EVENT_FOR_STATUS}) <> 1`);
  expect(transactionsWithoutOneStatusEvent).toEqual([]);
}

export async function eventTypesOf(db: TestDatabase, transactionId: string): Promise<string[]> {
  const rows = await db.sql`
    SELECT event_type FROM outbox_messages WHERE payload -> 'data' ->> 'transactionId' = ${transactionId} ORDER BY event_type`;
  return rows.map((row: { event_type: string }) => row.event_type);
}
