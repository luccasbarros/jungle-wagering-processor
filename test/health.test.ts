import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { INestApplication } from '@nestjs/common';
import { createApp } from '../src/app.module.ts';

describe('health endpoints', () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    app = await createApp();
    await app.listen(0);
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    await app.close();
  });

  it('answers 200 on /health/live while the process is up, so an orchestrator does not restart a healthy instance', async () => {
    const res = await fetch(`${baseUrl}/health/live`);
    expect(res.status).toBe(200);
  });
});
