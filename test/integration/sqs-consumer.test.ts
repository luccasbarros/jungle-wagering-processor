import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { ChangeMessageVisibilityCommand, DeleteMessageCommand } from '@aws-sdk/client-sqs';
import { createApp } from '../../src/app.module.ts';
import { SubmitWagerTransaction } from '../../src/application/use-cases/submit-wager-transaction.ts';
import { MikroOrmUnitOfWork } from '../../src/infrastructure/persistence/mikro-orm-unit-of-work.ts';
import { SystemClock, UuidV7IdGenerator } from '../../src/infrastructure/system.ts';
import { CONSUMER_NAME, MAX_RECEIVE_COUNT, SqsConsumer } from '../../src/infrastructure/messaging/sqs-consumer.ts';
import { expectMoneyInvariants, startTestApps, wager, type TestApps, type WalletRef } from './support/test-app.ts';
import { createTestQueues, envelope, until, type TestQueues } from './support/test-sqs.ts';

// Lock timeout (3s) plus the retry backoff put the slow paths past bun's 5s default.
const TEST_TIMEOUT_MS = 30_000;

let apps: TestApps;
let queues: TestQueues;
let consumer: SqsConsumer;

beforeAll(async () => {
  apps = await startTestApps('sqs_consumer');
  queues = await createTestQueues('sqs_consumer');
});

beforeEach(async () => {
  await queues.purge();
  const uow = new MikroOrmUnitOfWork(apps.db.orm);
  const clock = new SystemClock();
  consumer = new SqsConsumer(queues.sqs, new SubmitWagerTransaction(uow, clock, new UuidV7IdGenerator()), uow, clock, queues.config);
});

afterEach(async () => {
  await consumer.stop();
  await expectMoneyInvariants(apps.db);
});

afterAll(async () => {
  queues.close();
  await apps.close();
});

const sendEnvelope = (wallet: WalletRef, message: Record<string, unknown>) => queues.send(JSON.stringify(message), wallet.id);

async function debitsOf(walletId: string): Promise<number> {
  const [row] = await apps.db.sql`SELECT count(*)::int AS debits FROM wallet_ledger_entries WHERE wallet_id = ${walletId} AND direction = 'DEBIT'`;
  return row.debits;
}

async function inboxRowsFor(messageId: string): Promise<number> {
  const [row] = await apps.db.sql`SELECT count(*)::int AS rows FROM inbox_messages WHERE consumer_name = ${CONSUMER_NAME} AND message_id = ${messageId}`;
  return row.rows;
}

const mainQueueDrained = () => queues.depth(queues.config.queueUrl).then((depth) => depth === 0);

/** Holds FOR SHARE on the wallet: every consumer write lock on it waits (and hits lock_timeout) until `release`. */
async function holdWalletLock(walletId: string): Promise<{ release(): Promise<void> }> {
  const holder = await apps.db.sql.reserve();
  await holder`BEGIN`;
  await holder`SELECT id FROM wallets WHERE id = ${walletId} FOR SHARE`;
  return {
    async release() {
      await holder`COMMIT`;
      holder.release();
    },
  };
}

async function someoneWaitsOnALock(): Promise<boolean> {
  const [row] = await apps.db.sql`
    SELECT count(*)::int AS waiting FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
  return row.waiting > 0;
}

describe('SQS consumer of wager-transactions.fifo', () => {
  it('debits the wallet once when the broker delivers the same messageId twice', async () => {
    const wallet = await apps.apis[0]!.wallet('100.00');
    const message = envelope(wager(wallet));
    await sendEnvelope(wallet, message);
    await sendEnvelope(wallet, message);

    consumer.start();
    await until('both deliveries consumed', mainQueueDrained);

    expect(await debitsOf(wallet.id)).toBe(1);
    expect(await inboxRowsFor(message.messageId as string)).toBe(1);
    expect(consumer.metrics.duplicatesDetected).toBe(1);
    expect(consumer.metrics.processedByStatus).toEqual({ PROCESSED: 1 });
  }, TEST_TIMEOUT_MS);

  it('treats a new messageId carrying an already processed operation as an idempotent replay with a single effect', async () => {
    const wallet = await apps.apis[0]!.wallet('100.00');
    const body = wager(wallet);
    const first = envelope(body);
    const second = envelope(body);
    await sendEnvelope(wallet, first);
    await sendEnvelope(wallet, second);

    consumer.start();
    await until('both messages consumed', mainQueueDrained);

    expect(await debitsOf(wallet.id)).toBe(1);
    expect(await inboxRowsFor(first.messageId as string)).toBe(1);
    expect(await inboxRowsFor(second.messageId as string)).toBe(1);
    expect(consumer.metrics.idempotentReplays).toBe(1);
    expect(consumer.metrics.duplicatesDetected).toBe(0);
  }, TEST_TIMEOUT_MS);

  it('does not debit again when the worker died after the commit and before the ack', async () => {
    const wallet = await apps.apis[0]!.wallet('100.00');
    const message = envelope(wager(wallet));
    await sendEnvelope(wallet, message);

    const [delivery] = await queues.receive(queues.config.queueUrl);
    expect(await consumer.handle(delivery!)).toBe('committed');
    expect(await debitsOf(wallet.id)).toBe(1);
    // The crash: no DeleteMessage; the visibility timeout expiring is what the broker would do 30s later.
    await queues.sqs.send(new ChangeMessageVisibilityCommand({ QueueUrl: queues.config.queueUrl, ReceiptHandle: delivery!.ReceiptHandle, VisibilityTimeout: 0 }));

    consumer.start();
    // Queue depth lags a visibility change on LocalStack, so wait for the consumer to see the redelivery first.
    await until('the redelivery to be recognized by the inbox', async () => consumer.metrics.duplicatesDetected === 1);
    await until('the ack', mainQueueDrained);

    expect(await debitsOf(wallet.id)).toBe(1);
    expect(await inboxRowsFor(message.messageId as string)).toBe(1);
    expect(consumer.metrics.processedByStatus).toEqual({ PROCESSED: 1 });
  }, TEST_TIMEOUT_MS);

  it('moves a message that is not valid JSON to the DLQ with the reason and consumes it from the main queue', async () => {
    await queues.send('{not json', 'garbage');

    consumer.start();
    await until('message consumed', mainQueueDrained);

    const [dead] = await queues.receive(queues.config.dlqUrl);
    expect(dead?.Body).toBe('{not json');
    expect(dead?.MessageAttributes?.failureCode?.StringValue).toBe('INVALID_PAYLOAD');
    expect(dead?.MessageAttributes?.failureReason?.StringValue).toContain('JSON');
    expect(consumer.metrics.deadLettered).toBe(1);
  }, TEST_TIMEOUT_MS);

  it('dead-letters an OPENING submission instead of retrying it, persisting nothing', async () => {
    const wallet = await apps.apis[0]!.wallet('100.00');
    const message = envelope(wager(wallet, { kind: 'OPENING' }));
    await sendEnvelope(wallet, message);

    consumer.start();
    await until('message consumed', mainQueueDrained);

    const [dead] = await queues.receive(queues.config.dlqUrl);
    expect(dead?.MessageAttributes?.failureCode?.StringValue).toBe('KIND_NOT_SUBMITTABLE');
    expect(await inboxRowsFor(message.messageId as string)).toBe(0);
    const [{ count }] = await apps.db.sql`SELECT count(*)::int AS count FROM wager_transactions WHERE wallet_id = ${wallet.id} AND kind <> 'OPENING'`;
    expect(count).toBe(0);
  }, TEST_TIMEOUT_MS);

  it('retries a message that failed on a lock timeout and processes it once the wallet is free', async () => {
    const wallet = await apps.apis[0]!.wallet('100.00');
    const lock = await holdWalletLock(wallet.id);
    const message = envelope(wager(wallet));
    await sendEnvelope(wallet, message);

    consumer.start();
    await until('the first delivery to hit lock_timeout', async () => consumer.metrics.retries === 1, 15_000);
    expect(await debitsOf(wallet.id)).toBe(0);
    await lock.release();

    await until('the redelivery to be consumed', mainQueueDrained, 15_000);
    expect(await debitsOf(wallet.id)).toBe(1);
    expect(await inboxRowsFor(message.messageId as string)).toBe(1);
    expect(consumer.metrics.processedByStatus).toEqual({ PROCESSED: 1 });
  }, TEST_TIMEOUT_MS);

  it('dead-letters a transient failure on the last delivery the redrive policy allows, with the reason', async () => {
    const wallet = await apps.apis[0]!.wallet('100.00');
    const lock = await holdWalletLock(wallet.id);
    await sendEnvelope(wallet, envelope(wager(wallet)));
    const [delivery] = await queues.receive(queues.config.queueUrl);
    const lastAllowed = { ...delivery!, Attributes: { ...delivery!.Attributes, ApproximateReceiveCount: String(MAX_RECEIVE_COUNT) } };

    try {
      expect(await consumer.handle(lastAllowed)).toBe('dead-lettered');
    } finally {
      await lock.release();
    }

    const [dead] = await queues.receive(queues.config.dlqUrl);
    expect(dead?.Body).toBe(delivery!.Body);
    expect(dead?.MessageAttributes?.failureCode?.StringValue).toBe('TRANSIENT_FAILURE');
    expect(await debitsOf(wallet.id)).toBe(0);
    await queues.sqs.send(new DeleteMessageCommand({ QueueUrl: queues.config.queueUrl, ReceiptHandle: delivery!.ReceiptHandle }));
  }, TEST_TIMEOUT_MS);

  it('finishes the message in flight and returns the visibility of the rest of the batch when asked to stop', async () => {
    const blocked = await apps.apis[0]!.wallet('100.00');
    const untouched = await apps.apis[0]!.wallet('100.00');
    const lock = await holdWalletLock(blocked.id);
    await sendEnvelope(blocked, envelope(wager(blocked)));
    await sendEnvelope(untouched, envelope(wager(untouched)));

    consumer.start();
    await until('the first message to wait on the wallet lock', someoneWaitsOnALock);
    const stopped = consumer.stop();
    await lock.release();
    await stopped;

    expect(await debitsOf(blocked.id)).toBe(1);
    expect(await debitsOf(untouched.id)).toBe(0);
    expect(consumer.metrics.returnedToQueue).toBe(1);
    const [handedBack] = await queues.receive(queues.config.queueUrl);
    expect(JSON.parse(handedBack?.Body ?? '{}').data?.walletId).toBe(untouched.id);
  }, TEST_TIMEOUT_MS);

  it('stops as soon as the current poll ends when idle, instead of polling again', async () => {
    consumer.start();
    await Bun.sleep(200);
    const started = Date.now();
    await consumer.stop();
    expect(Date.now() - started).toBeLessThan((queues.config.waitTimeSeconds + 1) * 1000);
  }, TEST_TIMEOUT_MS);

  it('starts polling with the application and stops with it', async () => {
    const app = await createApp({ databaseUrl: apps.db.url, sqs: queues.config });
    await app.listen(0);
    try {
      const wallet = await apps.apis[0]!.wallet('100.00');
      await sendEnvelope(wallet, envelope(wager(wallet)));
      await until('the application consumer to process the message', async () => (await debitsOf(wallet.id)) === 1);
      await until('the ack', mainQueueDrained);
    } finally {
      await app.close();
    }
  }, TEST_TIMEOUT_MS);
});
