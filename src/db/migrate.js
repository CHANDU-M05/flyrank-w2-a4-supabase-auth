// Schema creation and seeding, as CLI entry points. `npm run migrate` runs them against DATABASE_URL.
//
// The SQL itself lives in src/repositories/tasks.js, one module, so that "are all queries
// parameterised?" can be answered by reading one file — the rule Week 3 established and kept here.
const { createPool, waitForDatabase } = require('./pool');
const { describeTarget } = require('./schema');

async function main() {
  require('dotenv').config({ path: require('node:path').join(__dirname, '..', '..', '.env') });

  const databaseUrl = (process.env.DATABASE_URL || '').trim();
  if (!databaseUrl) {
    console.error('[migrate] DATABASE_URL is not set. See .env.example.');
    process.exit(1);
  }

  const { createTasksRepository } = require('../repositories/tasks');
  const target = describeTarget(databaseUrl);
  const pool = createPool(databaseUrl);

  try {
    await waitForDatabase(pool, { target });
    const report = await createTasksRepository(pool).init();
    console.log(`[migrate] ${target}: ${report.seeded} seeded, ${report.total} row(s)`);
    await pool.end();
  } catch (error) {
    console.error(`[migrate] ${error.message}`);
    await pool.end().catch(() => {});
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
