import { createOrm } from './orm.ts';

// Run once per deploy, not on app boot: several instances booting together would race on the DDL.
const orm = await createOrm();
try {
  if (process.argv[2] === 'down') await orm.migrator.down({ to: 0 });
  else await orm.migrator.up();
} finally {
  await orm.close(true);
}
