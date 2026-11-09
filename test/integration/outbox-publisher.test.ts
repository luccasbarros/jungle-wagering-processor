import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import {
  CreateQueueCommand,
  DeleteMessageCommand,
  PurgeQueueCommand,
  ReceiveMessageCommand,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { createApp } from '../../src/app.module.ts';
import { Clock } from '../../src/application/ports/clock.ts';
import { UnitOfWork, type Repositories } from '../../src/application/ports/unit-of-work.ts';
import { PublishOutbox } from '../../src/application/use-cases/publish-outbox.ts';
import { IntegrationEvent } from '../../src/domain/events/integration-event.ts';
import { OUTBOX_BASE_RETRY_DELAY_MS } from '../../src/domain/outbox-message.ts';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work.ts';
import { SqsEventPublisher } from '../../src/infrastructure/messaging/sqs-event-publisher.ts';
import { createSqsClient, DEFAULT_SQS_ENDPOINT } from '../../src/infrastructure/messaging/sqs.ts';
import { OUTBOX_POLL_INTERVAL_MS } from '../../src/infrastructure/messaging/outbox-publisher.ts';
import { apiClient, expectMoneyInvariants } from './support/test-app.ts';
import { createTestDatabase, type TestDatabase } from './support/test-database.ts';

const TEST_QUEUE = 'wager-events-test.fifo';

interface Received {
  eventId: string;
  eventType: string;
  groupId: string;
  dedupId: string;
}

/** Receives and acks everything until the queue answers empty; FIFO hands out at most 10 per call. */
async function drain(sqs: SQSClient, queueUrl: string): Promise<Received[]> {
  const received: Received[] = [];
  for (;;) {
    const { Messages = [] } = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 1,
        MessageSystemAttributeNames: ['MessageGroupId', 'MessageDeduplicationId'],
      }),
    );
    if (Messages.length === 0) return received;
    for (const message of Messages) {
      const body = JSON.parse(message.Body!);
      received.push({
        eventId: body.eventId,
        eventType: body.eventType,
        groupId: message.Attributes!.MessageGroupId!,
        dedupId: message.Attributes!.MessageDeduplicationId!,
      });
      await sqs.send(new DeleteMessageCommand({ QueueUrl: queueUrl, ReceiptHandle: message.ReceiptHandle! }));
    }
  }
}

async function outboxRows(db: TestDatabase) {
  const rows = await db.sql`
    SELECT id, aggregate_id, occurred_at, attempts, next_attempt_at, published_at FROM outbox_messages ORDER BY occurred_at, id`;
  return rows as {
    id: string;
    aggregate_id: string;
    occurred_at: Date;
    attempts: number;
    next_attempt_at: Date | null;
    published_at: Date | null;
  }[];
}

async function waitUntil(check: () => Promise<boolean>, timeoutMs = 5_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await Bun.sleep(50);
  }
  return check();
}

const allPublished = (db: TestDatabase) => async () => (await outboxRows(db)).every((row) => row.published_at !== null);

class TestEvent extends IntegrationEvent<{ n: number }> {
  readonly eventType = 'TestEvent';
  readonly version = 1;

  constructor(aggregateId: string, n: number, occurredAt: Date = new Date()) {
    super({ eventId: Bun.randomUUIDv7(), aggregateId, correlationId: 'test', occurredAt, data: { n } });
  }
}

class TestClock extends Clock {
  constructor(public at: Date = new Date()) {
    super();
  }

  now(): Date {
    return this.at;
  }
}

let sqs: SQSClient;
let queueUrl: string;

beforeAll(async () => {
  sqs = createSqsClient();
  const { QueueUrl } = await sqs.send(new CreateQueueCommand({ QueueName: TEST_QUEUE, Attributes: { FifoQueue: 'true' } }));
  queueUrl = QueueUrl!;
  process.env.WAGER_EVENTS_QUEUE_URL = queueUrl;
});

afterAll(() => {
  delete process.env.WAGER_EVENTS_QUEUE_URL;
  sqs.destroy();
});

beforeEach(async () => {
  await sqs.send(new PurgeQueueCommand({ QueueUrl: queueUrl }));
  await drain(sqs, queueUrl);
});

describe('publisher loop inside the Nest app', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase('outbox_publisher_loop');
  });

  afterAll(async () => {
    await db.drop();
  });

  const rowsOf = async (wallets: { id: string }[]) => {
    const ids = new Set(wallets.map((wallet) => wallet.id));
    return (await outboxRows(db)).filter((row) => ids.has(row.aggregate_id));
  };

  it('delivers a committed wallet opening as two FIFO messages grouped by wallet and deduplicated by eventId', async () => {
    const app = await createApp({ databaseUrl: db.url });
    await app.listen(0);
    try {
      const api = apiClient(await app.getUrl());
      const wallet = await api.wallet('100.00');

      expect(await waitUntil(allPublished(db))).toBe(true);
      const received = await drain(sqs, queueUrl);
      const rows = await rowsOf([wallet]);

      expect(rows).toHaveLength(2);
      expect(received.map((m) => m.eventType)).toEqual(['WagerTransactionProcessed', 'WalletBalanceChanged']);
      expect(received.map((m) => m.eventId)).toEqual(rows.map((row) => row.id));
      expect(received.every((m) => m.groupId === wallet.id && m.dedupId === m.eventId)).toBe(true);
      await expectMoneyInvariants(db);
    } finally {
      await app.close();
    }
  });

  it('publishes every event exactly once across two app instances sharing the outbox, in wallet order', async () => {
    const apps = await Promise.all([createApp({ databaseUrl: db.url }), createApp({ databaseUrl: db.url })]);
    await Promise.all(apps.map((app) => app.listen(0)));
    try {
      const apis = await Promise.all(apps.map(async (app) => apiClient(await app.getUrl())));
      const wallets = await Promise.all(Array.from({ length: 10 }, (_, i) => apis[i % 2]!.wallet('1000.00')));
      const bets = wallets.flatMap((wallet) =>
        Array.from({ length: 6 }, (_, i) =>
          apis[i % 2]!.submit({
            providerId: 'provider-a',
            externalTransactionId: crypto.randomUUID(),
            playerId: wallet.playerId,
            walletId: wallet.id,
            roundId: `round-${i}`,
            gameId: 'fortune-chimp',
            kind: 'BET',
            money: { amount: '10.00', currency: 'BRL' },
          }),
        ),
      );
      const responses = await Promise.all(bets);
      expect(responses.every((res) => res.status === 200)).toBe(true);

      expect(await waitUntil(allPublished(db), 15_000)).toBe(true);
      const received = await drain(sqs, queueUrl);
      const rows = await rowsOf(wallets);

      expect(rows.length).toBe(10 * 2 + 60 * 2);
      expect(new Set(received.map((m) => m.eventId)).size).toBe(rows.length);
      expect(received).toHaveLength(rows.length);
      // Total order per wallet, siblings included: rows come back ordered by (occurred_at, id), the publisher's claim order.
      for (const wallet of wallets) {
        const expectedOrder = rows.filter((row) => row.aggregate_id === wallet.id).map((row) => row.id);
        expect(expectedOrder).toHaveLength(2 + 6 * 2);
        expect(received.filter((m) => m.groupId === wallet.id).map((m) => m.eventId)).toEqual(expectedOrder);
      }
      await expectMoneyInvariants(db);
    } finally {
      await Promise.all(apps.map((app) => app.close()));
    }
  }, 30_000);

  it('stops claiming once the app closes, so a shutdown never leaves a half-published batch behind', async () => {
    const app = await createApp({ databaseUrl: db.url });
    await app.listen(0);
    const uow = new MikroOrmUnitOfWork(db.orm);
    const [beforeClose, afterClose] = [new TestEvent(crypto.randomUUID(), 1), new TestEvent(crypto.randomUUID(), 2)];
    const publishedAt = async (event: TestEvent) => (await outboxRows(db)).find((row) => row.id === event.eventId)?.published_at ?? null;
    await uow.transaction(({ outbox }) => outbox.enqueue([beforeClose]));
    expect(await waitUntil(async () => (await publishedAt(beforeClose)) !== null)).toBe(true);

    await app.close();

    await uow.transaction(({ outbox }) => outbox.enqueue([afterClose]));
    await Bun.sleep(OUTBOX_POLL_INTERVAL_MS * 3);
    expect(await publishedAt(afterClose)).toBeNull();
  });
});

describe('one publisher round against the real queue', () => {
  let db: TestDatabase;
  let uow: UnitOfWork;
  let clock: TestClock;
  let publisher: PublishOutbox;

  beforeAll(async () => {
    db = await createTestDatabase('outbox_publisher_round');
    uow = new MikroOrmUnitOfWork(db.orm);
  });

  afterAll(async () => {
    await db.drop();
  });

  beforeEach(async () => {
    await db.sql`DELETE FROM outbox_messages`;
    clock = new TestClock();
    publisher = new PublishOutbox(uow, new SqsEventPublisher(sqs, queueUrl), clock);
  });

  const enqueue = (events: TestEvent[]) => uow.transaction(({ outbox }) => outbox.enqueue(events));

  it('publishes nothing for an event whose transaction rolled back, even with a publisher running meanwhile', async () => {
    class RolledBack extends Error {}
    const run = uow.transaction(async ({ outbox }) => {
      await outbox.enqueue([new TestEvent(crypto.randomUUID(), 1)]);
      await publisher.execute();
      throw new RolledBack();
    });
    await expect(run).rejects.toBeInstanceOf(RolledBack);

    expect(await publisher.execute()).toEqual({ published: 0, failed: 0 });
    expect(await outboxRows(db)).toEqual([]);
    expect(await drain(sqs, queueUrl)).toEqual([]);
  });

  it('skips the row another publisher holds and publishes the rest without waiting', async () => {
    const events = [1, 2, 3].map((n) => new TestEvent(crypto.randomUUID(), n));
    await enqueue(events);
    const otherPublisher = await db.sql.reserve();
    try {
      await otherPublisher`BEGIN`;
      await otherPublisher`SELECT id FROM outbox_messages WHERE id = ${events[1]!.eventId} FOR UPDATE`;

      const started = Date.now();
      expect(await publisher.execute()).toEqual({ published: 2, failed: 0 });
      expect(Date.now() - started).toBeLessThan(2_000);
    } finally {
      await otherPublisher`ROLLBACK`;
      otherPublisher.release();
    }
    const rows = await outboxRows(db);
    expect(rows.filter((row) => row.published_at !== null).map((row) => row.id)).toEqual([events[0]!.eventId, events[2]!.eventId]);
    expect(rows.find((row) => row.id === events[1]!.eventId)!.published_at).toBeNull();
    expect((await drain(sqs, queueUrl)).map((m) => m.eventId)).toEqual([events[0]!.eventId, events[2]!.eventId]);
  });

  it('holds back a sibling event of the same aggregate and instant while the earlier-emitted one is still pending', async () => {
    const aggregateId = crypto.randomUUID();
    const at = new Date();
    const [first, second] = [new TestEvent(aggregateId, 1, at), new TestEvent(aggregateId, 2, at)];
    await enqueue([first, second]);
    const otherPublisher = await db.sql.reserve();
    try {
      await otherPublisher`BEGIN`;
      await otherPublisher`SELECT id FROM outbox_messages WHERE id = ${first.eventId} FOR UPDATE`;
      expect(await publisher.execute()).toEqual({ published: 0, failed: 0 });
    } finally {
      await otherPublisher`ROLLBACK`;
      otherPublisher.release();
    }

    // One event per aggregate per round: the claim is one snapshot, so the sibling leaves on the next round.
    expect(await publisher.execute()).toEqual({ published: 1, failed: 0 });
    expect(await publisher.execute()).toEqual({ published: 1, failed: 0 });
    expect((await drain(sqs, queueUrl)).map((m) => m.eventId)).toEqual([first.eventId, second.eventId]);
  });

  it('lets another instance republish when a publisher dies after publishing but before committing, and the queue sees one eventId', async () => {
    class Died extends Error {}
    class DiesBeforeCommit extends UnitOfWork {
      transaction<T>(work: (repositories: Repositories) => Promise<T>): Promise<T> {
        return uow.transaction(async (repositories) => {
          await work(repositories);
          throw new Died();
        });
      }
      read<T>(work: (repositories: Repositories) => Promise<T>): Promise<T> {
        return uow.read(work);
      }
    }
    const event = new TestEvent(crypto.randomUUID(), 1);
    await enqueue([event]);

    const dying = new PublishOutbox(new DiesBeforeCommit(), new SqsEventPublisher(sqs, queueUrl), clock);
    await expect(dying.execute()).rejects.toBeInstanceOf(Died);
    expect((await outboxRows(db))[0]!.published_at).toBeNull();

    expect(await publisher.execute()).toEqual({ published: 1, failed: 0 });
    expect((await outboxRows(db))[0]!.published_at).not.toBeNull();

    const received = await drain(sqs, queueUrl);
    expect(received.length).toBeGreaterThanOrEqual(1);
    expect(received.length).toBeLessThanOrEqual(2);
    expect(new Set(received.map((m) => m.eventId))).toEqual(new Set([event.eventId]));
  });

  it('schedules a backoff retry while SQS is unavailable and publishes once it is back', async () => {
    let down = true;
    const target = new URL(DEFAULT_SQS_ENDPOINT);
    const proxy = Bun.serve({
      port: 0,
      fetch(request) {
        if (down) return new Response('unavailable', { status: 503 });
        const url = new URL(request.url);
        url.host = target.host;
        return fetch(url, { method: request.method, headers: request.headers, body: request.body });
      },
    });
    const flakySqs = createSqsClient(`http://localhost:${proxy.port}`);
    try {
      const flaky = new PublishOutbox(uow, new SqsEventPublisher(flakySqs, queueUrl), clock);
      const event = new TestEvent(crypto.randomUUID(), 1);
      await enqueue([event]);

      expect(await flaky.execute()).toEqual({ published: 0, failed: 1 });
      const [afterFailure] = await outboxRows(db);
      expect(afterFailure!.attempts).toBe(1);
      expect(afterFailure!.published_at).toBeNull();
      expect(afterFailure!.next_attempt_at!.getTime()).toBe(clock.at.getTime() + 2 * OUTBOX_BASE_RETRY_DELAY_MS);

      down = false;
      expect(await flaky.execute()).toEqual({ published: 0, failed: 0 });

      clock.at = new Date(afterFailure!.next_attempt_at!.getTime());
      expect(await flaky.execute()).toEqual({ published: 1, failed: 0 });
      expect((await drain(sqs, queueUrl)).map((m) => m.eventId)).toEqual([event.eventId]);
    } finally {
      flakySqs.destroy();
      proxy.stop(true);
    }
  });
});
