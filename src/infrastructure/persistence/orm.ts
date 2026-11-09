import { defineConfig, MikroORM } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { Migration20261109000000InitialSchema } from './migrations/Migration20261109000000InitialSchema.ts';
import { ENTITY_SCHEMAS } from './schemas.ts';

export const DEFAULT_DATABASE_URL = 'postgresql://wagering:wagering@localhost:5432/wagering';

export const databaseUrl = (): string => process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;

export function ormConfig(clientUrl: string = databaseUrl()) {
  return defineConfig({
    clientUrl,
    entities: ENTITY_SCHEMAS,
    extensions: [Migrator],
    migrations: {
      // hand-written SQL (CHECK, partial index, trigger) is the schema of record; the automatic diff would not reproduce it
      snapshot: false,
      migrationsList: [{ name: 'Migration20261109000000InitialSchema', class: Migration20261109000000InitialSchema }],
    },
  });
}

export const createOrm = (clientUrl?: string): Promise<MikroORM> => MikroORM.init(ormConfig(clientUrl));
