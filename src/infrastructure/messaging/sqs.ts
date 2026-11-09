import { SQSClient } from '@aws-sdk/client-sqs';

export const DEFAULT_SQS_ENDPOINT = 'http://localhost:4566';
export const DEFAULT_WAGER_EVENTS_QUEUE_URL = `${DEFAULT_SQS_ENDPOINT}/000000000000/wager-events.fifo`;

export const sqsEndpoint = (): string => process.env.SQS_ENDPOINT ?? DEFAULT_SQS_ENDPOINT;
export const wagerEventsQueueUrl = (): string => process.env.WAGER_EVENTS_QUEUE_URL ?? DEFAULT_WAGER_EVENTS_QUEUE_URL;

// LocalStack accepts any credentials; real AWS would come from the environment, which wins when set.
export function createSqsClient(endpoint: string = sqsEndpoint()): SQSClient {
  return new SQSClient({
    endpoint,
    region: process.env.AWS_REGION ?? 'us-east-1',
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? 'test',
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? 'test',
    },
  });
}

export interface SqsConsumerConfig {
  queueUrl: string;
  dlqUrl: string;
  /** Long-poll length; also the upper bound a stop waits, since an aborted poll still delivers server-side (seen on LocalStack). */
  waitTimeSeconds: number;
}

const DEFAULT_WAIT_TIME_SECONDS = 20;

/** Consumer is opt-in per process: without SQS_INPUT_QUEUE_URL the app serves HTTP only. The DLQ follows the init-aws.sh naming unless given. */
export function sqsConsumerConfigFromEnv(): SqsConsumerConfig | undefined {
  const queueUrl = process.env.SQS_INPUT_QUEUE_URL;
  if (!queueUrl) return undefined;
  return {
    queueUrl,
    dlqUrl: process.env.SQS_DLQ_URL ?? queueUrl.replace(/\.fifo$/, '-dlq.fifo'),
    waitTimeSeconds: parseInt(process.env.SQS_WAIT_TIME_SECONDS ?? String(DEFAULT_WAIT_TIME_SECONDS), 10),
  };
}
