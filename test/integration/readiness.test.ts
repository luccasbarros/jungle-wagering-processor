import { afterEach, describe, expect, it } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../../src/app.module.ts';
import { databaseUrl } from '../../src/infrastructure/persistence/orm.ts';

// Port 1 refuses connections at once, so "down" is deterministic and does not wait for a timeout.
const DEAD_DATABASE_URL = 'postgresql://wagering:wagering@127.0.0.1:1/wagering';
const DEAD_SQS_ENDPOINT = 'http://127.0.0.1:1';

let app: INestApplication | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function start(config: Parameters<typeof createApp>[0]): Promise<string> {
  app = await createApp(config);
  await app.listen(0);
  return app.getUrl();
}

async function get(url: string) {
  const res = await fetch(url);
  return { status: res.status, body: await res.json() };
}

describe('GET /health/ready', () => {
  it('answers 200 when Postgres and the input queue both answer', async () => {
    const baseUrl = await start({ databaseUrl: databaseUrl() });

    expect(await get(`${baseUrl}/health/ready`)).toEqual({ status: 200, body: { ready: true, postgres: true, sqs: true } });
  });

  it('answers 503 naming Postgres when the database is unreachable, while live stays 200', async () => {
    const baseUrl = await start({ databaseUrl: DEAD_DATABASE_URL });

    expect(await get(`${baseUrl}/health/ready`)).toEqual({ status: 503, body: { ready: false, postgres: false, sqs: true } });
    expect((await fetch(`${baseUrl}/health/live`)).status).toBe(200);
  });

  it('answers 503 naming SQS when the queue endpoint is unreachable, so an instance that cannot consume leaves the load balancer', async () => {
    const baseUrl = await start({ databaseUrl: databaseUrl(), observability: { sqsEndpoint: DEAD_SQS_ENDPOINT } });

    expect(await get(`${baseUrl}/health/ready`)).toEqual({ status: 503, body: { ready: false, postgres: true, sqs: false } });
  });
});
