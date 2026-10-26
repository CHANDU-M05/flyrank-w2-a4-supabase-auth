// Every SQL statement in the project, in one module. The routes decide HTTP; this decides what the
// database is asked to do — the split Week 3 settled on, kept because it is what lets a reviewer
// check "all queries are parameterised" by reading a single file.
//
// Rule: no request value is ever concatenated into SQL text. The only thing interpolated into a
// statement is a `$n` placeholder whose number comes from params.length, an integer this module
// controls. Values go in the parameter array and Postgres parses them there.
const { DatabaseError } = require('../errors');
const { SCHEMA, RLS, SEEDS } = require('../db/schema');

// A search box that lets you type `%` would otherwise let you ask for the whole table, and `_`
// matches any single character. Escaping them in the *value* — not in the SQL text — is what the
// ESCAPE clause below is for, and Week 3 verified it with `search=%` returning the one row whose
// title actually contains a percent sign.
function escapeLike(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_');
}

function databaseError(error, action) {
  // error.message only. pg also carries .detail / .context / .hint, and those can quote the failing
  // statement back — which is exactly the thing a client must not see.
  return new DatabaseError(`${action}: ${error.message}`, { cause: error });
}

// One parameter group per row. The interpolated text is `$n` where n is arithmetic on the position
// in the array, never a value.
function valuesClause(rows, columns) {
  return rows
    .map((row, groupIndex) => {
      const inner = row.map((_, columnIndex) => `$${groupIndex * columns + columnIndex + 1}`);
      return `(${inner.join(', ')})`;
    })
    .join(', ');
}

function seedParams(seeds) {
  return seeds.map((seed) => [seed.title, seed.done]);
}

async function run(db, sql, params, action) {
  try {
    return await db.query(sql, params);
  } catch (error) {
    throw databaseError(error, action);
  }
}

// A transaction on one dedicated connection. A pool hands `BEGIN` and `COMMIT` to whatever client
// is free, so multi-statement work must hold one client for itself — which is also what makes the
// lock below belong to this transaction rather than to the pool.
async function withTransaction(db, work) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function createTasksRepository(db) {
  return {
    // Asked and answered inside this module so that /health can report on the only dependency the
    // process actually has. Returns false instead of throwing: the caller wants a health status,
    // not a stack trace, and the reason for the failure goes to the log.
    async ping() {
      try {
        await db.query('SELECT 1 AS ok');
        return true;
      } catch (error) {
        // The driver's message goes to the log, never to the response. pg does not put the
        // connection string in error.message, so there is nothing here to leak.
        console.error('[db] health check failed:', error.message);
        return false;
      }
    },

    // CREATE TABLE IF NOT EXISTS is idempotent, so this runs on every boot and on a fresh database
    // alike. RLS is a separate statement because ALTER has no IF NOT EXISTS; it is idempotent by
    // nature.
    async ensureSchema() {
      try {
        await db.query(SCHEMA);
        await db.query(RLS);
      } catch (error) {
        throw databaseError(error, 'could not create the tasks table');
      }
    },

    // Returns the number of rows inserted: 0 when the table already had data, 3 on an empty one.
    //
    // This is Week 3's hardest lesson, repeated in the JavaScript lane rather than quietly dropped.
    // "Count the rows, and if there are none insert the seeds" is a check-then-act race: under
    // Postgres' default READ COMMITTED a plain SELECT takes no lock, so two processes starting
    // together can both count zero and both insert — six tasks instead of three, still in the table
    // tomorrow. Week 3 measured both halves of that (6 rows without the lock, 3 with it).
    async initSeeds(seeds = SEEDS) {
      try {
        return await withTransaction(db, async (client) => {
          // SHARE ROW EXCLUSIVE blocks other writers from inserting while letting readers through.
          // It has to be taken inside the transaction and before the count, otherwise the count is
          // read under a lock nobody holds.
          await client.query('LOCK TABLE tasks IN SHARE ROW EXCLUSIVE MODE');
          const { rows } = await client.query('SELECT COUNT(*)::int AS n FROM tasks');
          if (rows[0].n > 0) return 0;

          const params = seedParams(seeds);
          await client.query(
            `INSERT INTO tasks (title, done) VALUES ${valuesClause(params, 2)} RETURNING id`,
            params.flat(),
          );
          return seeds.length;
        });
      } catch (error) {
        throw databaseError(error, 'could not seed the tasks table');
      }
    },

    // Back to exactly the three seeds, with the id sequence rewound so the first task created after
    // a reset is id 4 — documented since Week 2. Truncating without RESTART IDENTITY would leave the
    // sequence where it was and silently change that promise.
    async reset(seeds = SEEDS) {
      try {
        return await withTransaction(db, async (client) => {
          await client.query('TRUNCATE TABLE tasks RESTART IDENTITY');
          const params = seedParams(seeds);
          await client.query(
            `INSERT INTO tasks (title, done) VALUES ${valuesClause(params, 2)} RETURNING id`,
            params.flat(),
          );
          return seeds.length;
        });
      } catch (error) {
        throw databaseError(error, 'could not reset the tasks table');
      }
    },

    async init() {
      await this.ensureSchema();
      const seeded = await this.initSeeds();
      const { rows } = await run(db, 'SELECT COUNT(*)::int AS n FROM tasks', [], 'could not count tasks');
      return { seeded, total: rows[0].n };
    },

    async list({ done, search } = {}) {
      const conditions = [];
      const params = [];

      if (done !== undefined && done !== null) {
        params.push(done);
        conditions.push(`done = $${params.length}`);
      }
      if (search !== undefined && search !== null && search !== '') {
        params.push(`%${escapeLike(search)}%`);
        conditions.push(`title ILIKE $${params.length} ESCAPE '\\'`);
      }

      const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
      const { rows } = await run(
        db,
        `SELECT id, title, done FROM tasks${where} ORDER BY id`,
        params,
        'could not list tasks',
      );
      return rows;
    },

    async get(id) {
      const { rows } = await run(
        db,
        'SELECT id, title, done FROM tasks WHERE id = $1',
        [id],
        'could not read task',
      );
      return rows[0] || null;
    },

    async create({ title, done = false }) {
      const { rows } = await run(
        db,
        'INSERT INTO tasks (title, done) VALUES ($1, $2) RETURNING id, title, done',
        [title, done],
        'could not create task',
      );
      return rows[0];
    },

    // Returns the row as the database now holds it, or null when the id is not there. `RETURNING`
    // means the client is told what was written rather than what it asked for — a distinction that
    // matters as soon as the database is allowed to change a value.
    async update(id, { title, done }) {
      const sets = [];
      const params = [];

      if (title !== undefined) {
        params.push(title);
        sets.push(`title = $${params.length}`);
      }
      if (done !== undefined) {
        params.push(done);
        sets.push(`done = $${params.length}`);
      }
      if (sets.length === 0) return this.get(id);

      params.push(id);
      const { rows } = await run(
        db,
        `UPDATE tasks SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING id, title, done`,
        params,
        'could not update task',
      );
      return rows[0] || null;
    },

    async remove(id) {
      const { rows } = await run(
        db,
        'DELETE FROM tasks WHERE id = $1 RETURNING id',
        [id],
        'could not delete task',
      );
      return rows.length > 0;
    },

    async stats() {
      const { rows } = await run(
        db,
        'SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE done)::int AS done FROM tasks',
        [],
        'could not count tasks',
      );
      const { total, done } = rows[0];
      return { total, done, open: total - done };
    },
  };
}

module.exports = { createTasksRepository, escapeLike, valuesClause };
