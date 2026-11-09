import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  PurgeQueueCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type Message,
  type SQSClient,
} from '@aws-sdk/client-sqs';
import { createSqsClient, sqsClientConfigFromEnv, type SqsConfig } from '../../../src/infrastructure/messaging/sqs.ts';
import { MAX_RECEIVE_COUNT, WAGER_TRANSACTION_REQUESTED } from '../../../src/infrastructure/messaging/sqs-consumer.ts';
import type { WagerBody } from './test-app.ts';
import { defaultKey } from './test-app.ts';

export interface TestQueues {
  sqs: SQSClient;
  config: SqsConfig;
  purge(): Promise<void>;
  /** FIFO send; the group defaults to the wallet so the producer convention (one group per wallet) holds in tests. */
  send(body: string, groupId: string): Promise<void>;
  receive(queueUrl: string, waitSeconds?: number): Promise<Message[]>;
  /** Visible + in flight, so a message that was received but not acked still counts. */
  depth(queueUrl: string): Promise<number>;
  close(): void;
}

// Same shape as the compose queues (FIFO, 30s visibility, redrive after MAX_RECEIVE_COUNT), one pair per test file.
export async function createTestQueues(name: string): Promise<TestQueues> {
  const base = sqsClientConfigFromEnv();
  const sqs = createSqsClient(base);
  const dlq = await sqs.send(new CreateQueueCommand({ QueueName: `test_${name}-dlq.fifo`, Attributes: { FifoQueue: 'true' } }));
  const { Attributes } = await sqs.send(new GetQueueAttributesCommand({ QueueUrl: dlq.QueueUrl, AttributeNames: ['QueueArn'] }));
  const main = await sqs.send(
    new CreateQueueCommand({
      QueueName: `test_${name}.fifo`,
      Attributes: {
        FifoQueue: 'true',
        VisibilityTimeout: '30',
        RedrivePolicy: JSON.stringify({ deadLetterTargetArn: Attributes!.QueueArn, maxReceiveCount: String(MAX_RECEIVE_COUNT) }),
      },
    }),
  );
  // 1s polls keep each stop() in the suite short; production uses the 20s default.
  const config: SqsConfig = { ...base, queueUrl: main.QueueUrl!, dlqUrl: dlq.QueueUrl!, waitTimeSeconds: 1 };

  const queues: TestQueues = {
    sqs,
    config,
    async purge() {
      await sqs.send(new PurgeQueueCommand({ QueueUrl: config.queueUrl }));
      await sqs.send(new PurgeQueueCommand({ QueueUrl: config.dlqUrl }));
    },
    async send(body, groupId) {
      await sqs.send(new SendMessageCommand({ QueueUrl: config.queueUrl, MessageBody: body, MessageGroupId: groupId, MessageDeduplicationId: crypto.randomUUID() }));
    },
    async receive(queueUrl, waitSeconds = 2) {
      const { Messages } = await sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: queueUrl,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: waitSeconds,
          MessageSystemAttributeNames: ['ApproximateReceiveCount', 'MessageGroupId'],
          MessageAttributeNames: ['All'],
        }),
      );
      return Messages ?? [];
    },
    async depth(queueUrl) {
      const { Attributes } = await sqs.send(
        new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: ['ApproximateNumberOfMessages', 'ApproximateNumberOfMessagesNotVisible'] }),
      );
      return parseInt(Attributes?.ApproximateNumberOfMessages ?? '0', 10) + parseInt(Attributes?.ApproximateNumberOfMessagesNotVisible ?? '0', 10);
    },
    close() {
      sqs.destroy();
    },
  };
  await queues.purge();
  return queues;
}

/** Spec section 10 message; `data.idempotencyKey` plays the role of the HTTP header. */
export function envelope(body: WagerBody, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    messageId: crypto.randomUUID(),
    type: WAGER_TRANSACTION_REQUESTED,
    occurredAt: new Date().toISOString(),
    data: { ...body, idempotencyKey: defaultKey(body) },
    ...overrides,
  };
}

const POLL_MS = 25;

/** Polls `condition` until it holds; fails with `what` after `timeoutMs`. */
export async function until(what: string, condition: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(POLL_MS);
  }
}
