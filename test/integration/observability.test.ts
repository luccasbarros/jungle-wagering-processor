import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../../src/app.module.ts';
import { createLogger } from '../../src/infrastructure/observability/logger.ts';
import { createTestDatabase, type TestDatabase } from './support/test-database.ts';
import { apiClient, BRL, expectMoneyInvariants, wager, type ApiClient } from './support/test-app.ts';

const REQUIRED_METRICS = [
  'wager_transactions_total',
  'duplicates_detected_total',
  'retries_total',
  'dlq_messages_total',
  'lock_conflicts_total',
  'outbox_lag_seconds',
  'processing_duration_seconds',
];

// Distinct amounts, so finding one of them anywhere in a log line means money leaked.
const BET_AMOUNT = '73.19';
const OPENING_AMOUNT = '1000.00';
const BALANCE_AFTER_BET = '926.81';

let db: TestDatabase;
let app: INestApplication;
let api: ApiClient;
let baseUrl: string;
const logLines: string[] = [];

beforeAll(async () => {
  db = await createTestDatabase('observability');
  app = await createApp({
    databaseUrl: db.url,
    observability: { logLevel: 'info', logDestination: { write: (line: string) => void logLines.push(line) } },
  });
  await app.listen(0);
  baseUrl = await app.getUrl();
  api = apiClient(baseUrl);
});

afterEach(async () => {
  await expectMoneyInvariants(db);
});

afterAll(async () => {
  await app.close();
  await db.drop();
});

async function scrape(): Promise<string> {
  const res = await fetch(`${baseUrl}/metrics`);
  expect(res.status).toBe(200);
  return res.text();
}

/** Value of one exposition line such as `wager_transactions_total{status="PROCESSED"}`; 0 when the series was never touched. */
function sample(exposition: string, series: string): number {
  const line = exposition.split('\n').find((l) => l.startsWith(`${series} `));
  return line ? parseFloat(line.slice(series.length + 1)) : 0;
}

async function delta(series: string, action: () => Promise<unknown>): Promise<number> {
  const before = sample(await scrape(), series);
  await action();
  return sample(await scrape(), series) - before;
}

async function requestLine(correlationId: string): Promise<Record<string, unknown>> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const line = logLines.find((l) => l.includes('request completed') && l.includes(correlationId));
    if (line) return JSON.parse(line);
    await Bun.sleep(20);
  }
  throw new Error(`no request log line for ${correlationId}`);
}

describe('GET /metrics', () => {
  it('exposes every metric the spec requires in the Prometheus text format', async () => {
    const res = await fetch(`${baseUrl}/metrics`);
    const body = await res.text();

    expect(res.headers.get('content-type')).toContain('text/plain');
    for (const name of REQUIRED_METRICS) expect(body).toContain(`# TYPE ${name} `);
  });

  it('counts a processed and a rejected transaction under their own status', async () => {
    const wallet = await api.wallet('10.00');
    const processed = 'wager_transactions_total{status="PROCESSED"}';
    const rejected = 'wager_transactions_total{status="REJECTED"}';
    const before = await scrape();

    expect((await api.submit(wager(wallet, { money: BRL('4.00') }))).status).toBe(200);
    expect((await api.submit(wager(wallet, { money: BRL('50.00') }))).status).toBe(422);

    const after = await scrape();
    expect(sample(after, processed) - sample(before, processed)).toBe(1);
    expect(sample(after, rejected) - sample(before, rejected)).toBe(1);
  });

  it('counts an idempotent replay as a duplicate and not as a new decision', async () => {
    const wallet = await api.wallet('10.00');
    const bet = wager(wallet);
    await api.submit(bet);
    const before = await scrape();

    const replay = await api.submit(bet);

    const after = await scrape();
    expect(replay.body.idempotentReplay).toBe(true);
    expect(sample(after, 'duplicates_detected_total{source="http"}') - sample(before, 'duplicates_detected_total{source="http"}')).toBe(1);
    expect(sample(after, 'wager_transactions_total{status="PROCESSED"}')).toBe(sample(before, 'wager_transactions_total{status="PROCESSED"}'));
  });

  it('observes the processing latency of every submission, replays included', async () => {
    const wallet = await api.wallet('10.00');
    const bet = wager(wallet);

    const observed = await delta('processing_duration_seconds_count', async () => {
      await api.submit(bet);
      await api.submit(bet);
    });

    expect(observed).toBe(2);
  });

  it('counts a request that gave up waiting for a locked wallet as a lock_timeout conflict', async () => {
    const wallet = await api.wallet('10.00');

    const conflicts = await delta('lock_conflicts_total{reason="lock_timeout"}', () =>
      db.sql.begin(async (tx) => {
        await tx`SELECT 1 FROM wallets WHERE id = ${wallet.id} FOR SHARE`;
        expect((await api.submit(wager(wallet))).status).toBe(503);
      }),
    );

    expect(conflicts).toBe(1);
  }, 10_000);

  it('reports the age of the oldest unpublished outbox event as the outbox lag', async () => {
    await api.wallet('10.00');
    await Bun.sleep(300);

    expect(sample(await scrape(), 'outbox_lag_seconds')).toBeGreaterThanOrEqual(0.3);
  });
});

describe('request logs', () => {
  it('print one JSON line per request with its correlationId, walletId and transactionId and no money amount', async () => {
    const wallet = await api.wallet(OPENING_AMOUNT);
    const correlationId = crypto.randomUUID();

    const res = await api.submit(wager(wallet, { money: BRL(BET_AMOUNT) }), undefined, { 'x-correlation-id': correlationId });

    const line = await requestLine(correlationId);
    expect(line).toMatchObject({ correlationId, walletId: wallet.id, transactionId: res.body.transactionId, providerId: 'provider-a', status: 'PROCESSED' });
    const everyLineOfTheRequest = logLines.filter((l) => l.includes(correlationId)).join('\n');
    for (const amount of [BET_AMOUNT, OPENING_AMOUNT, BALANCE_AFTER_BET]) expect(everyLineOfTheRequest).not.toContain(amount);
  });

  it('generate a correlationId when the header is missing and use the same one in the response, the log and the outbox event', async () => {
    const wallet = await api.wallet('10.00');

    const res = await api.submit(wager(wallet));

    const correlationId = res.headers.get('x-correlation-id')!;
    expect(correlationId).toMatch(/^[0-9a-f-]{36}$/);
    expect((await requestLine(correlationId)).transactionId).toBe(res.body.transactionId);
    const events = await db.sql`SELECT payload ->> 'correlationId' AS correlation_id FROM outbox_messages WHERE payload -> 'data' ->> 'transactionId' = ${res.body.transactionId}`;
    expect([...new Set(events.map((e: { correlation_id: string }) => e.correlation_id))]).toEqual([correlationId]);
  });
});

describe('logger', () => {
  it('redacts money nested in a whole transaction or event that someone logs by mistake', () => {
    const lines: string[] = [];
    const logger = createLogger({ level: 'info', destination: { write: (line: string) => void lines.push(line) } });

    logger.info(
      {
        money: BRL(BET_AMOUNT),
        transaction: { id: 'tx-1', money: BRL(BET_AMOUNT), balance: BRL(BALANCE_AFTER_BET) },
        event: { data: { balanceBefore: BRL(OPENING_AMOUNT), balanceAfter: BRL(BALANCE_AFTER_BET) } },
      },
      'whole objects',
    );

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('tx-1');
    for (const amount of [BET_AMOUNT, OPENING_AMOUNT, BALANCE_AFTER_BET]) expect(lines[0]).not.toContain(amount);
  });
});
