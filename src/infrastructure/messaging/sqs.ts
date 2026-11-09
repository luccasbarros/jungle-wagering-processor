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
