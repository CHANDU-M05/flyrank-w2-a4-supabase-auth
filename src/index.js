// Startup wiring. Everything a test needs is behind createApp(); this file is the part a test does
// not want: environment, connections, a socket, and the exit codes.
const { createApp } = require('./app');
const { loadConfig, describe, ConfigError } = require('./config');
const { createPool, waitForDatabase } = require('./db/pool');
const { describeTarget } = require('./db/schema');
const { createTasksRepository } = require('./repositories/tasks');
const { createSupabaseClient, signOutAs } = require('./supabase');

function fail(message) {
  console.error(`[startup] ${message}`);
  process.exit(1);
}

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    // The message already names the variable and says where it should have come from. Nothing from
    // here on can run without it, so print and leave — and never print the value we are missing.
    if (error instanceof ConfigError) fail(error.message);
    throw error;
  }

  const target = describeTarget(config.databaseUrl);
  const pool = createPool(config.databaseUrl);

  const supabase = createSupabaseClient(config);
  const tasks = createTasksRepository(pool);

  try {
    await waitForDatabase(pool, { target });
    const report = await tasks.init();
    console.log(
      `[startup] Postgres ready at ${target} (${report.seeded} seeded, ${report.total} row(s))`,
    );
  } catch (error) {
    await pool.end().catch(() => {});
    fail(error.message);
  }

  // Sign-out is request-scoped, so it is bound here to the project's own URL and public key and given
  // to the app as a callable: the only per-request argument is the caller's bearer token. Leaving it
  // injectable is what lets a test assert a 204 or a 502 without a network.
  const signOut = ({ accessToken }) =>
    signOutAs({ supabaseUrl: config.supabaseUrl, supabaseKey: config.supabaseKey, accessToken });

  const app = createApp({ tasks, supabase, signOut });

  const server = app.listen(config.port, () => {
    // describe() is the only way configuration reaches this line, and it cannot produce a secret.
    const summary = describe(config);
    console.log(
      `[startup] listening on http://localhost:${summary.port} ` +
        `(auth: ${summary.auth}, db: ${summary.database})`,
    );
  });

  server.on('error', (error) => {
    const hint =
      error.code === 'EADDRINUSE'
        ? `port ${config.port} is already taken — stop the other process or set PORT in .env`
        : error.message;
    fail(hint);
  });

  // Ctrl+C should not leave the pool's sockets hanging, and a killed server should stop accepting
  // requests before the database goes away underneath it.
  const shutdown = (signal) => {
    console.log(`[shutdown] ${signal}`);
    server.close(() => {
      pool.end().then(() => process.exit(0)).catch(() => process.exit(1));
    });
    // If a request refuses to finish, do not wait for it forever.
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((error) => {
  console.error('[startup] unhandled:', error);
  process.exit(1);
});
