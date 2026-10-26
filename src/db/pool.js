// The pg pool. Kept tiny and explicitly created, rather than a module-level singleton, so that a
// test can build an app against a fake database without importing this file at all.
const { Pool } = require('pg');

const { DatabaseError } = require('../errors');

function createPool(databaseUrl) {
  if (!databaseUrl) {
    throw new DatabaseError(
      'DATABASE_URL is not set. The task endpoints need a Postgres connection; copy .env.example ' +
        'to .env and point DATABASE_URL at your database.',
    );
  }

  const pool = new Pool({ connectionString: databaseUrl, max: 5 });

  // An idle client that dies in the background must not take the process with it. Logged without
  // the connection string, which pg does not put in this error anyway.
  pool.on('error', (error) => {
    console.error('[db] unexpected error on idle client:', error.message);
  });

  return pool;
}

// Compose can tell you a container is healthy; that is not the same as this process being able to
// connect, and on a cold start the two are seconds apart. Week 3 learned that the hard way, so the
// retry is here again rather than being traded for startup ordering.
async function waitForDatabase(pool, { attempts = 30, delayMs = 1000, target = '?' } = {}) {
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await pool.query('SELECT 1 AS ok');
      return { attempts: attempt, target };
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  throw new DatabaseError(
    `cannot connect to Postgres at ${target} after ${attempts} attempts: ${lastError?.message || 'unknown error'}`,
    { cause: lastError },
  );
}

module.exports = { createPool, waitForDatabase };
