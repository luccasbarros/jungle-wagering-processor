import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { SQL } from 'bun';
import { DeleteMessageBatchCommand, PurgeQueueCommand, ReceiveMessageCommand, SendMessageCommand, type SQSClient } from '@aws-sdk/client-sqs';
import { databaseUrl } from '../../src/infrastructure/persistence/orm.ts';
import { createSqsClient, wagerEventsQueueUrl } from '../../src/infrastructure/messaging/sqs.ts';
import { CONSUMER_NAME } from '../../src/infrastructure/messaging/sqs-consumer.ts';
import { apiClient, BRL, expectMoneyInvariants, wager, type ApiResponse, type WagerBody, type WalletRef } from '../integration/support/test-app.ts';
import { envelope, until } from '../integration/support/test-sqs.ts';

// The stack `bun run test:e2e` brings up: three app replicas behind nginx, sharing the compose Postgres and LocalStack.
const BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:3000';
const INPUT_QUEUE_URL = process.env.SQS_INPUT_QUEUE_URL ?? 'http://localhost:4566/000000000000/wager-transactions.fifo';
const COMPOSE_PROJECT = 'jungle-wagering-processor';
const REPLICAS = 3;

// A restart of all replicas keeps nginx answering 502 for up to the 30 s stop grace; the client keeps retrying past that.
const LOAD_TIMEOUT_MS = 120_000;
const RETRY_PAUSE_MS = 250;
const MAX_RETRIES = 240;
const GATEWAY_FAILURES = new Set([502, 503, 504]);

const api = apiClient(BASE_URL);
let sql: SQL;
let sqs: SQSClient;
const walletsOfThisRun = new Set<string>();

beforeAll(async () => {
  sql = new SQL(databaseUrl());
  sqs = createSqsClient();
  await sqs.send(new PurgeQueueCommand({ QueueUrl: wagerEventsQueueUrl() }));
  await expectReplicas(REPLICAS);
});

afterEach(async () => {
  await expectMoneyInvariants({ sql });
});

afterAll(async () => {
  sqs.destroy();
  await sql.close();
});

async function openWallet(amount: string): Promise<WalletRef> {
  const wallet = await api.wallet(amount);
  walletsOfThisRun.add(wallet.id);
  return wallet;
}

/** What a provider does on a gateway error: the same request, same Idempotency-Key, until an instance answers. */
async function submitUntilAnswered(body: WagerBody, retried: { count: number }): Promise<ApiResponse> {
  let response: ApiResponse | undefined;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      response = await api.submit(body);
      if (!GATEWAY_FAILURES.has(response.status)) return response;
    } catch {
      // nginx reset the connection while every replica was down
    }
    retried.count++;
    await Bun.sleep(RETRY_PAUSE_MS);
  }
  throw new Error(`gave up after ${MAX_RETRIES} attempts, last status ${response?.status}`);
}

async function walletState(walletId: string) {
  const [row] = await sql`
    SELECT w.balance::text AS balance, w.version,
           (SELECT count(*)::int FROM wallet_ledger_entries e WHERE e.wallet_id = w.id AND e.direction = 'DEBIT') AS debits,
           (SELECT count(*)::int FROM wager_transactions t WHERE t.wallet_id = w.id AND t.kind <> 'OPENING') AS transactions
    FROM wallets w WHERE w.id = ${walletId}`;
  return row as { balance: string; version: number; debits: number; transactions: number };
}

async function inboxRowsFor(messageId: string): Promise<number> {
  const [row] = await sql`SELECT count(*)::int AS rows FROM inbox_messages WHERE consumer_name = ${CONSUMER_NAME} AND message_id = ${messageId}`;
  return row.rows;
}

async function unpublishedOutboxRows(): Promise<number> {
  const [row] = await sql`SELECT count(*)::int AS pending FROM outbox_messages WHERE published_at IS NULL`;
  return row.pending;
}

const outboxDrained = () => unpublishedOutboxRows().then((pending) => pending === 0);

const compose = async (...args: string[]): Promise<string> => {
  const proc = Bun.spawn(['docker', 'compose', '-p', COMPOSE_PROJECT, ...args], { stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`docker compose ${args.join(' ')} exited ${code}: ${err}`);
  return out.trim();
};

const runningReplicas = async (): Promise<string[]> => (await compose('ps', '-q', '--status', 'running', 'app')).split('\n').filter(Boolean);

const startedAt = async (containers: string[]): Promise<string[]> =>
  (await new Response(Bun.spawn(['docker', 'inspect', '--format', '{{.State.StartedAt}}', ...containers], { stdout: 'pipe' }).stdout).text()).trim().split('\n');

/** One counter sample summed over the replicas' own /metrics (nginx would pick one at random). */
async function sumAcrossReplicas(sample: string): Promise<number> {
  const scrapes = await Promise.all(
    (await runningReplicas()).map((id) => new Response(Bun.spawn(['docker', 'exec', id, 'wget', '-qO-', 'http://localhost:3000/metrics'], { stdout: 'pipe' }).stdout).text()),
  );
  return scrapes.reduce((sum, text) => sum + Number(text.match(new RegExp(`^${sample.replace(/[{}"=]/g, '\\$&')} (\\S+)`, 'm'))?.[1] ?? 0), 0);
}

async function expectReplicas(count: number): Promise<void> {
  await until(`${count} running replicas`, async () => (await runningReplicas()).length === count, 60_000);
  await until('nginx to answer from a ready replica', async () => (await api.get('/health/ready')).status === 200, 60_000);
}

/** Holds FOR SHARE on the wallet so every write lock waits; releases once `blocked` sessions wait on a lock. */
async function underSharedWalletLock<T>(walletId: string, blocked: number, requests: () => Promise<T>): Promise<T> {
  const holder = await sql.reserve();
  try {
    await holder`BEGIN`;
    await holder`SELECT id FROM wallets WHERE id = ${walletId} FOR SHARE`;
    const pending = requests();
    await until(`${blocked} requests waiting on the wallet lock`, async () => {
      const [row] = await sql`SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
      return row.waiting >= blocked;
    });
    await holder`COMMIT`;
    return await pending;
  } finally {
    holder.release();
  }
}

const statusesOf = (responses: ApiResponse[]) => responses.map((res) => res.status).sort();

describe('three replicas behind nginx', () => {
  it('processes exactly one of two concurrent 80.00 bets on 100.00, rejects the other, and leaves 20.00 with one debit', async () => {
    const wallet = await openWallet('100.00');
    const bets = [wager(wallet, { money: BRL('80.00') }), wager(wallet, { money: BRL('80.00') })];

    const responses = await underSharedWalletLock(wallet.id, bets.length, () => Promise.all(bets.map((bet) => api.submit(bet))));

    expect(statusesOf(responses)).toEqual([200, 422]);
    expect(responses.find((res) => res.status === 422)!.body).toMatchObject({ status: 'REJECTED', failureCode: 'INSUFFICIENT_FUNDS', balance: BRL('20.00') });
    expect(await walletState(wallet.id)).toEqual({ balance: '20.00', version: 2, debits: 1, transactions: 2 });
  }, 15_000);

  it('debits once when the same bet arrives 50 times in parallel, every copy answering with the original result', async () => {
    const wallet = await openWallet('100.00');
    const bet = wager(wallet, { money: BRL('10.00') });

    const responses = await Promise.all(Array.from({ length: 50 }, () => api.submit(bet)));

    expect(responses.map((res) => res.status)).toEqual(Array(50).fill(200));
    expect(new Set(responses.map((res) => res.body.transactionId)).size).toBe(1);
    expect(responses.filter((res) => !res.body.idempotentReplay)).toHaveLength(1);
    expect(await walletState(wallet.id)).toEqual({ balance: '90.00', version: 2, debits: 1, transactions: 1 });
  }, 15_000);

  it('keeps every wallet correct when bets for many wallets run at the same time', async () => {
    const wallets = await Promise.all(Array.from({ length: 10 }, () => openWallet('30.00')));

    await Promise.all(wallets.flatMap((wallet) => Array.from({ length: 5 }, () => api.submit(wager(wallet, { money: BRL('10.00') })))));

    for (const wallet of wallets) expect(await walletState(wallet.id)).toEqual({ balance: '0.00', version: 4, debits: 3, transactions: 5 });
  }, 15_000);
});

describe('SQS input shared by the replicas', () => {
  const send = (message: Record<string, unknown>, groupId: string) =>
    sqs.send(new SendMessageCommand({ QueueUrl: INPUT_QUEUE_URL, MessageBody: JSON.stringify(message), MessageGroupId: groupId, MessageDeduplicationId: crypto.randomUUID() }));

  it('applies a BET published three times under different groups once, and a ROLLBACK that arrived before it once the BET lands', async () => {
    const wallet = await openWallet('100.00');
    const bet = wager(wallet, { money: BRL('25.00') });
    const betMessage = envelope(bet);
    const rollback = envelope(wager(wallet, { kind: 'ROLLBACK', money: bet.money, referenceExternalTransactionId: bet.externalTransactionId }));

    const inboxDuplicates = 'duplicates_detected_total{detector="inbox"}';
    const keyDuplicates = 'duplicates_detected_total{detector="idempotency_key"}';
    const before = { inbox: await sumAcrossReplicas(inboxDuplicates), key: await sumAcrossReplicas(keyDuplicates) };

    await send(rollback, wallet.id);
    // Different groups: FIFO hands the three copies to three replicas at once, so only the inbox can stop them.
    await Promise.all([0, 1, 2].map((copy) => send(betMessage, `${betMessage.messageId}-${copy}`)));

    await until('the ROLLBACK to be applied after its BET', async () => (await walletState(wallet.id)).transactions === 2 && (await statusesFor(wallet.id)).every((s) => s === 'PROCESSED'), 30_000);
    await until('the two extra copies to be acked', async () => (await sumAcrossReplicas(inboxDuplicates)) - before.inbox === 2, 30_000);

    expect(await walletState(wallet.id)).toEqual({ balance: '100.00', version: 3, debits: 1, transactions: 2 });
    expect(await inboxRowsFor(betMessage.messageId as string)).toBe(1);
    expect(await inboxRowsFor(rollback.messageId as string)).toBe(1);
    // The inbox stopped both copies; the idempotency key never gets to count them a second time.
    expect((await sumAcrossReplicas(keyDuplicates)) - before.key).toBe(0);
  }, 45_000);

  async function statusesFor(walletId: string): Promise<string[]> {
    const rows = await sql`SELECT status FROM wager_transactions WHERE wallet_id = ${walletId} AND kind <> 'OPENING'`;
    return rows.map((row: { status: string }) => row.status);
  }
});

describe('replica failure under load', () => {
  const WALLETS = 15;
  const BET = '1.00';
  const OPENING = '1000.00';
  const ROUND_PAUSE_MS = 1000;
  const ROUNDS_AFTER = 3;

  const lockWaiters = async (): Promise<number> => {
    const [row] = await sql`SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
    return row.waiting;
  };

  /** One bet per wallet per round, a round every second while `disrupt` lasts and a few after it, so requests meet the stack going down and coming back. Returns rounds fired and gateway failures the client retried. */
  async function load(wallets: WalletRef[], disrupt: () => Promise<void>): Promise<{ rounds: number; retried: number }> {
    const retried = { count: 0 };
    const rounds: Promise<ApiResponse[]>[] = [];
    const fire = () => rounds.push(Promise.all(wallets.map((wallet) => submitUntilAnswered(wager(wallet, { money: BRL(BET) }), retried))));
    fire();
    let over = false;
    const disruption = disrupt().finally(() => (over = true));
    while (!over) {
      await Bun.sleep(ROUND_PAUSE_MS);
      fire();
    }
    await disruption;
    for (let i = 0; i < ROUNDS_AFTER; i++) fire();
    const responses = (await Promise.all(rounds)).flat();
    expect(responses.filter((res) => res.status !== 200)).toEqual([]);
    return { rounds: rounds.length, retried: retried.count };
  }

  async function expectConsistentEnd(wallets: WalletRef[], rounds: number): Promise<void> {
    const balance = (1000 - rounds).toFixed(2);
    for (const wallet of wallets) expect(await walletState(wallet.id)).toEqual({ balance, version: 1 + rounds, debits: rounds, transactions: rounds });
    await until('every outbox row to be published by a surviving replica', outboxDrained, 30_000);
    await expectReplicas(REPLICAS);
  }

  it('keeps balance == SUM(ledger) for every wallet and leaves no outbox row stuck when a replica is killed with SIGKILL while its requests sit inside their transactions', async () => {
    const wallets = await Promise.all(Array.from({ length: WALLETS }, () => openWallet(OPENING)));
    const [victim] = await runningReplicas();
    // FOR SHARE on every wallet parks the first round inside its SQL transactions (transaction row inserted, wallet lock pending) on all three replicas.
    const holder = await sql.reserve();
    await holder`BEGIN`;
    await holder`SELECT id FROM wallets WHERE id = ANY(${`{${wallets.map((w) => w.id).join(',')}}`}::uuid[]) FOR SHARE`;
    let outcome: { rounds: number; retried: number };
    try {
      outcome = await load(wallets, async () => {
        await until('the first round to wait on the wallet locks', async () => (await lockWaiters()) >= WALLETS);
        await Bun.spawn(['docker', 'kill', '--signal=SIGKILL', victim!]).exited;
        await holder`COMMIT`;
      });
    } finally {
      holder.release();
      await Bun.spawn(['docker', 'start', victim!]).exited;
    }

    console.log(`SIGKILL run: ${outcome.rounds} rounds, ${outcome.retried} gateway failure(s) retried by the client`);
    expect(outcome.retried).toBeGreaterThan(0);
    await expectConsistentEnd(wallets, outcome.rounds);
  }, LOAD_TIMEOUT_MS);

  it('answers every request and ends consistent while every replica is restarted gracefully under load', async () => {
    const wallets = await Promise.all(Array.from({ length: WALLETS }, () => openWallet(OPENING)));
    const replicas = await runningReplicas();
    const before = await startedAt(replicas);

    const outcome = await load(wallets, () => compose('restart', 'app').then(() => undefined));

    // Compose restarts the replicas in parallel but never all three at once (measured: two together, the third ~6 s later), and nginx moves a refused connection to a live one, so the client usually sees no error at all.
    console.log(`graceful restart run: ${outcome.rounds} rounds, ${outcome.retried} gateway failure(s) retried by the client`);
    const after = await startedAt(replicas);
    expect(after.filter((time, i) => time === before[i])).toEqual([]);
    await expectConsistentEnd(wallets, outcome.rounds);
  }, LOAD_TIMEOUT_MS);
});

describe('events on wager-events.fifo', () => {
  it('delivers every outbox event of this run at least once, and a consumer deduplicating by eventId sees each exactly once', async () => {
    await until('the outbox to drain', outboxDrained, 30_000);
    const walletIds = `{${[...walletsOfThisRun].join(',')}}`;
    const expected = await sql`SELECT id FROM outbox_messages WHERE aggregate_id = ANY(${walletIds}::uuid[])`;
    const expectedIds = new Set<string>(expected.map((row: { id: string }) => row.id));

    const received = await drainEvents();
    const ofThisRun = received.filter((event) => walletsOfThisRun.has(event.aggregateId));
    const seen = new Set(ofThisRun.map((event) => event.eventId));
    console.log(`events: ${expectedIds.size} expected, ${ofThisRun.length} received, ${ofThisRun.length - seen.size} duplicate delivery(ies) dropped by eventId`);

    expect(expectedIds.size).toBeGreaterThan(0);
    expect([...expectedIds].filter((id) => !seen.has(id))).toEqual([]);
    expect(seen.size).toBe(expectedIds.size);
  }, 120_000);

  async function drainEvents(): Promise<{ eventId: string; aggregateId: string }[]> {
    const events: { eventId: string; aggregateId: string }[] = [];
    let emptyPolls = 0;
    while (emptyPolls < 3) {
      const { Messages = [] } = await sqs.send(new ReceiveMessageCommand({ QueueUrl: wagerEventsQueueUrl(), MaxNumberOfMessages: 10, WaitTimeSeconds: 1 }));
      if (Messages.length === 0) {
        emptyPolls++;
        continue;
      }
      emptyPolls = 0;
      for (const message of Messages) {
        const { eventId, aggregateId } = JSON.parse(message.Body!);
        events.push({ eventId, aggregateId });
      }
      await sqs.send(
        new DeleteMessageBatchCommand({ QueueUrl: wagerEventsQueueUrl(), Entries: Messages.map((m) => ({ Id: m.MessageId!, ReceiptHandle: m.ReceiptHandle! })) }),
      );
    }
    return events;
  }
});
