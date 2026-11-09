import { Module } from '@nestjs/common';
import { WalletQueriesController } from './interface/http/wallet-queries.controller.ts';
import { Metrics } from './application/ports/metrics.ts';
import { UnitOfWork } from './application/ports/unit-of-work.ts';
import { ReconcileWallet } from './application/use-cases/reconcile-wallet.ts';

// UnitOfWork, WageringQueries and Metrics come from the global AppModule.
@Module({
  controllers: [WalletQueriesController],
  providers: [
    {
      provide: ReconcileWallet,
      useFactory: (uow: UnitOfWork, metrics: Metrics) => new ReconcileWallet(uow, metrics),
      inject: [UnitOfWork, Metrics],
    },
  ],
})
export class QueriesModule {}
