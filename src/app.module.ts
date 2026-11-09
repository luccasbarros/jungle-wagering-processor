import 'reflect-metadata';
import { Module, type DynamicModule, type INestApplication } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, NestFactory } from '@nestjs/core';
import { MikroORM } from '@mikro-orm/postgresql';
import { HealthController } from './interface/http/health.controller.ts';
import { WalletsController } from './interface/http/wallets.controller.ts';
import { WageringController } from './interface/http/wagering.controller.ts';
import { HttpErrorFilter } from './interface/http/error.filter.ts';
import { AuthGuard } from './interface/http/auth.guard.ts';
import { Clock } from './application/ports/clock.ts';
import { IdGenerator } from './application/ports/id-generator.ts';
import { UnitOfWork } from './application/ports/unit-of-work.ts';
import { SubmitWagerTransaction } from './application/use-cases/submit-wager-transaction.ts';
import { CreateWallet } from './application/use-cases/create-wallet.ts';
import { WageringQueries } from './application/use-cases/wagering-queries.ts';
import { MikroOrmUnitOfWork } from './infrastructure/persistence/mikro-orm-unit-of-work.ts';
import { createOrm, databaseUrl } from './infrastructure/persistence/orm.ts';
import { SystemClock, UuidV7IdGenerator } from './infrastructure/system.ts';
import { pendingReferenceProviders } from './infrastructure/workers/pending-reference-worker.ts';

export interface AppConfig {
  databaseUrl: string;
}

class OrmShutdown {
  constructor(private readonly orm: MikroORM) {}

  async onApplicationShutdown(): Promise<void> {
    await this.orm.close();
  }
}

const useCase = <T>(UseCase: new (uow: UnitOfWork, clock: Clock, ids: IdGenerator) => T) => ({
  provide: UseCase,
  useFactory: (uow: UnitOfWork, clock: Clock, ids: IdGenerator) => new UseCase(uow, clock, ids),
  inject: [UnitOfWork, Clock, IdGenerator],
});

// Application classes stay free of Nest decorators; the module is the only place that knows how they are built.
@Module({})
export class AppModule {
  static register(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController, WalletsController, WageringController],
      providers: [
        { provide: MikroORM, useFactory: () => createOrm(config.databaseUrl) },
        { provide: OrmShutdown, useFactory: (orm: MikroORM) => new OrmShutdown(orm), inject: [MikroORM] },
        { provide: UnitOfWork, useFactory: (orm: MikroORM) => new MikroOrmUnitOfWork(orm), inject: [MikroORM] },
        { provide: Clock, useClass: SystemClock },
        { provide: IdGenerator, useClass: UuidV7IdGenerator },
        useCase(SubmitWagerTransaction),
        useCase(CreateWallet),
        { provide: WageringQueries, useFactory: (uow: UnitOfWork) => new WageringQueries(uow), inject: [UnitOfWork] },
        ...pendingReferenceProviders(),
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_FILTER, useClass: HttpErrorFilter },
      ],
    };
  }
}

export async function createApp(config: AppConfig = { databaseUrl: databaseUrl() }): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule.register(config), { logger: ['error', 'warn'] });
  app.enableShutdownHooks();
  return app;
}
