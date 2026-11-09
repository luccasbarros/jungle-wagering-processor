import { Module, type DynamicModule, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { MikroORM } from '@mikro-orm/postgresql';
import type { DestinationStream } from 'pino';
import { Metrics } from '../../application/ports/metrics.ts';
import { ObservabilityController } from '../../interface/http/observability.controller.ts';
import { RequestLoggingMiddleware } from '../../interface/http/request-logging.middleware.ts';
import { createLogger, NestPinoLogger } from './logger.ts';
import { PrometheusMetrics } from './prometheus-metrics.ts';
import { outboxLagSeconds, Readiness } from './readiness.ts';

const INPUT_QUEUE_NAME = 'wager-transactions.fifo';
const LOCALSTACK_ACCOUNT_ID = '000000000000';

export interface ObservabilityConfig {
  logLevel?: string;
  logDestination?: DestinationStream;
  sqsEndpoint?: string;
  inputQueueUrl?: string;
}

// The ORM lives in AppModule; non-strict lookup reuses its pool instead of opening a second one for probes.
const appOrm = (refs: ModuleRef) => (): MikroORM => refs.get<MikroORM, MikroORM>(MikroORM, { strict: false });

@Module({})
export class ObservabilityModule implements NestModule {
  static register(config: ObservabilityConfig = {}): DynamicModule {
    const endpoint = config.sqsEndpoint ?? process.env.AWS_ENDPOINT_URL ?? 'http://localhost:4566';
    const queueUrl = config.inputQueueUrl ?? process.env.SQS_INPUT_QUEUE_URL ?? `${endpoint}/${LOCALSTACK_ACCOUNT_ID}/${INPUT_QUEUE_NAME}`;
    return {
      module: ObservabilityModule,
      controllers: [ObservabilityController],
      providers: [
        { provide: NestPinoLogger, useValue: new NestPinoLogger(createLogger({ level: config.logLevel, destination: config.logDestination })) },
        {
          provide: PrometheusMetrics,
          useFactory: (refs: ModuleRef) => new PrometheusMetrics(() => outboxLagSeconds(appOrm(refs)())),
          inject: [ModuleRef],
        },
        { provide: Metrics, useExisting: PrometheusMetrics },
        {
          provide: Readiness,
          useFactory: (refs: ModuleRef) =>
            new Readiness(appOrm(refs), { endpoint, region: process.env.AWS_REGION ?? 'us-east-1', queueUrl }),
          inject: [ModuleRef],
        },
        RequestLoggingMiddleware,
      ],
      exports: [Metrics, NestPinoLogger],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RequestLoggingMiddleware).forRoutes('*');
  }
}
