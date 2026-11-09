import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createTestDatabase, type TestDatabase } from './support/test-database.ts';

const TABLES = ['wallets', 'wager_transactions', 'wallet_ledger_entries', 'inbox_messages', 'outbox_messages'];

describe('schema migrations', () => {
  let db: TestDatabase;

  beforeAll(async () => {
    db = await createTestDatabase('migrations');
  });

  afterAll(async () => {
    await db.drop();
  });

  const schemaObjects = async () => {
    const [row] = await db.sql`
      SELECT
        (SELECT count(*)::int FROM pg_tables WHERE schemaname = 'public' AND tablename IN ${db.sql(TABLES)}) AS tables,
        (SELECT count(*)::int FROM pg_trigger WHERE tgname = 'trg_ledger_immutable') AS triggers,
        (SELECT count(*)::int FROM pg_proc WHERE proname = 'ledger_immutable') AS functions`;
    return row;
  };

  it('creates every table and the ledger trigger on up, removes them all on down, and recreates them on a second up', async () => {
    expect(await schemaObjects()).toEqual({ tables: TABLES.length, triggers: 1, functions: 1 });

    await db.orm.migrator.down();
    expect(await schemaObjects()).toEqual({ tables: 0, triggers: 0, functions: 0 });

    await db.orm.migrator.up();
    expect(await schemaObjects()).toEqual({ tables: TABLES.length, triggers: 1, functions: 1 });
  });
});
