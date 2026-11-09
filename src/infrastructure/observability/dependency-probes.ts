import { GetQueueAttributesCommand, SQSClient } from '@aws-sdk/client-sqs';
import type { MikroORM } from '@mikro-orm/postgresql';

// A probe that hangs is a failed probe; orchestrators time out readiness checks within a few seconds.
const CHECK_TIMEOUT_MS = 2000;

const OUTBOX_LAG_SQL = `
  SELECT COALESCE(EXTRACT(EPOCH FROM now() - min(occurred_at)), 0)::float8 AS lag
  FROM outbox_messages WHERE published_at IS NULL`;

export interface ReadinessReport {
  ready: boolean;
  postgres: boolean;
  sqs: boolean;
}

export interface SqsTarget {
  endpoint: string;
  region: string;
  inputQueueUrl: string;
  deadLetterQueueUrl: string;
}

/** Live reads of Postgres and SQS for readiness and for the gauges computed at scrape time. */
export class DependencyProbes {
  private readonly sqs: SQSClient;

  constructor(
    private readonly orm: () => MikroORM,
    private readonly target: SqsTarget,
  ) {
    this.sqs = new SQSClient({
      endpoint: target.endpoint,
      region: target.region,
      maxAttempts: 1,
      ...(process.env.AWS_ACCESS_KEY_ID ? {} : { credentials: { accessKeyId: 'test', secretAccessKey: 'test' } }),
    });
  }

  async readiness(): Promise<ReadinessReport> {
    const [postgres, sqs] = await Promise.all([this.postgres(), this.queueAttribute(this.target.inputQueueUrl, 'QueueArn')]);
    return { ready: postgres && sqs !== undefined, postgres, sqs: sqs !== undefined };
  }

  /** NaN when the database cannot answer, so a scrape during an outage reads "unknown" instead of a stale lag. */
  async outboxLagSeconds(): Promise<number> {
    try {
      const [row] = await this.orm().em.getConnection().execute<{ lag: number }[]>(OUTBOX_LAG_SQL);
      return row?.lag ?? 0;
    } catch {
      return NaN;
    }
  }

  /** Messages waiting in the DLQ right now; the redrive policy moves them without the app seeing it, so only the queue knows. */
  async deadLetterDepth(): Promise<number> {
    const depth = await this.queueAttribute(this.target.deadLetterQueueUrl, 'ApproximateNumberOfMessages');
    return depth === undefined ? NaN : parseInt(depth, 10);
  }

  onApplicationShutdown(): void {
    this.sqs.destroy();
  }

  // Not orm.checkConnection(): it reports "not established" until the lazy pool has served a query.
  private async postgres(): Promise<boolean> {
    const probe = this.orm().em.getConnection().execute('SELECT 1').then(() => true, () => false);
    return (await withinTimeout(probe)) ?? false;
  }

  private async queueAttribute(queueUrl: string, name: 'QueueArn' | 'ApproximateNumberOfMessages'): Promise<string | undefined> {
    try {
      const { Attributes } = await this.sqs.send(new GetQueueAttributesCommand({ QueueUrl: queueUrl, AttributeNames: [name] }), {
        abortSignal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      });
      return Attributes?.[name];
    } catch {
      return undefined;
    }
  }
}

function withinTimeout<T>(work: Promise<T>): Promise<T | undefined> {
  let timer: Timer | undefined;
  const timeout = new Promise<undefined>((resolve) => (timer = setTimeout(resolve, CHECK_TIMEOUT_MS)));
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}
