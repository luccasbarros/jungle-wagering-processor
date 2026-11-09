import { SQL } from 'bun';
import type { MikroORM } from '@mikro-orm/postgresql';
import { createOrm, databaseUrl } from '../../../src/infrastructure/persistence/orm.ts';

export interface TestDatabase {
  url: string;
  sql: SQL;
  orm: MikroORM;
  drop(): Promise<void>;
}

// One database per test file, named after it: a crashed run is cleaned by the next one instead of leaking random databases.
export async function createTestDatabase(name: string): Promise<TestDatabase> {
  const database = `test_${name}`;
  const admin = new SQL(databaseUrl());
  await admin.unsafe(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
  await admin.unsafe(`CREATE DATABASE "${database}"`);

  const url = new URL(databaseUrl());
  url.pathname = `/${database}`;
  const orm = await createOrm(url.toString());
  await orm.migrator.up();
  const sql = new SQL(url.toString());

  return {
    url: url.toString(),
    sql,
    orm,
    async drop() {
      await sql.close();
      await orm.close(true);
      await admin.unsafe(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
      await admin.close();
    },
  };
}
