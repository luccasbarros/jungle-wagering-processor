import type { Provider } from '@nestjs/common';
import { SQSClient } from '@aws-sdk/client-sqs';
import { Clock } from '../../application/ports/clock.ts';
import { Metrics } from '../../application/ports/metrics.ts';
import { UnitOfWork } from '../../application/ports/unit-of-work.ts';
import { SubmitWagerTransaction } from '../../application/use-cases/submit-wager-transaction.ts';
import type { SqsConsumerConfig } from './sqs.ts';
import { SqsConsumer } from './sqs-consumer.ts';

/** Spread into AppModule's providers; without a config the app serves HTTP only (how the HTTP tests run). The SQSClient is the outbox's. */
export function sqsConsumerProviders(config: SqsConsumerConfig | undefined): Provider[] {
  if (!config) return [];
  return [
    {
      provide: SqsConsumer,
      useFactory: (sqs: SQSClient, submit: SubmitWagerTransaction, uow: UnitOfWork, clock: Clock, metrics: Metrics) =>
        new SqsConsumer(sqs, submit, uow, clock, metrics, config),
      inject: [SQSClient, SubmitWagerTransaction, UnitOfWork, Clock, Metrics],
    },
  ];
}
