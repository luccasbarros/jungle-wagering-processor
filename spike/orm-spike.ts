// Throwaway spike (S1): proves MikroORM 7 + EntitySchema + FOR UPDATE + migration up/down/up running on Bun. Not domain code.
import { strict as assert } from 'node:assert';
import { EntitySchema, LockMode, MikroORM } from '@mikro-orm/postgresql';
import { Migration, Migrator } from '@mikro-orm/migrations';

interface SpikeAccount {
  id: string;
  balance: string;
}

const SpikeAccountSchema = new EntitySchema<SpikeAccount>({
  name: 'SpikeAccount',
  tableName: 'spike_accounts',
  properties: {
    id: { type: 'uuid', primary: true },
    balance: { type: 'decimal', precision: 19, scale: 2 },
  },
});

class CreateSpikeAccounts extends Migration {
  override up(): void {
    this.addSql(`CREATE TABLE spike_accounts (
      id UUID PRIMARY KEY,
      balance NUMERIC(19,2) NOT NULL CHECK (balance >= 0)
    )`);
  }

  override down(): void {
    this.addSql('DROP TABLE spike_accounts');
  }
}

const sqlLog: string[] = [];

const orm = await MikroORM.init({
  entities: [SpikeAccountSchema],
  clientUrl: process.env.DATABASE_URL ?? 'postgresql://wagering:wagering@localhost:5432/wagering',
  extensions: [Migrator],
  migrations: {
    tableName: 'spike_migrations',
    // schema is hand-written SQL (CHECK, trigger), the automatic diff is not used; without snapshot no .snapshot-*.json is left in the repo
    snapshot: false,
    migrationsList: [{ name: 'CreateSpikeAccounts', class: CreateSpikeAccounts }],
  },
  debug: ['query'],
  logger: (msg) => {
    sqlLog.push(msg);
    console.log(msg);
  },
});

const tableExists = async () => {
  const rows = await orm.em.getConnection().execute<{ t: string | null }[]>(`SELECT to_regclass('spike_accounts')::text AS t`);
  return rows[0]?.t === 'spike_accounts';
};

try {
  await orm.migrator.up();
  assert.ok(await tableExists(), 'up 1 deveria criar a tabela');
  await orm.migrator.down();
  assert.ok(!(await tableExists()), 'down deveria remover a tabela');
  await orm.migrator.up();
  assert.ok(await tableExists(), 'up 2 deveria recriar a tabela');

  const id = Bun.randomUUIDv7();
  const seedEm = orm.em.fork();
  seedEm.create(SpikeAccountSchema, { id, balance: '100.00' });
  await seedEm.flush();

  const balance = await orm.em.fork().transactional(async (em) => {
    const account = await em.findOneOrFail(SpikeAccountSchema, id, { lockMode: LockMode.PESSIMISTIC_WRITE });
    account.balance = '20.00';
    return account.balance;
  });

  const persisted = await orm.em.fork().findOneOrFail(SpikeAccountSchema, id);
  assert.equal(typeof persisted.balance, 'string', 'NUMERIC tem que voltar como string, nunca number');
  assert.equal(persisted.balance, '20.00');
  assert.equal(balance, '20.00');
  assert.ok(sqlLog.some((l) => /for update/i.test(l)), 'the transactional SELECT should be emitted with FOR UPDATE');

  console.log('\nSPIKE OK: migration up/down/up, FOR UPDATE no log, NUMERIC como string');
} finally {
  await orm.migrator.down().catch(() => undefined);
  await orm.em.getConnection().execute('DROP TABLE IF EXISTS spike_migrations');
  await orm.close(true);
}
