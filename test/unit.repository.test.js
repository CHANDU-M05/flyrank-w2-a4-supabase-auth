// Proof that every query is parameterised, and proof of the two statements that make seed-once
// actually hold.
//
// The repository is run against a recording fake: it returns rows but ignores SQL, so what is being
// asserted is the *text* of each statement and the *array* of values that came with it. That is the
// only honest way to test "no request value is concatenated into SQL" without a database — and the
// payloads below are the ones that would break something if the rule were not being followed.
const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { DatabaseError } = require('../src/errors');
const { createTasksRepository, escapeLike, valuesClause } = require('../src/repositories/tasks');

function recordingDb({ countValue = 0, failWith = null } = {}) {
  const calls = [];

  const record = (sql, params) => {
    calls.push({ sql, params });
    if (failWith) throw failWith;
    if (/COUNT\(\*\)::int AS n/.test(sql)) return { rows: [{ n: countValue }] };
    return { rows: [] };
  };

  const client = {
    query: async (sql, params) => record(sql, params),
    // Releasing the connection is not a statement, so it is not recorded: the assertions below are
    // about the order of SQL, and a marker here would sit between COMMIT and whatever came next.
    release() {},
  };

  return {
    calls,
    query: async (sql, params) => record(sql, params),
    connect: async () => client,
  };
}

describe('SQL is parameterised, everywhere', () => {
  test('a search term with SQL in it stays in the parameter array', async () => {
    const db = recordingDb();
    const payload = "'; DROP TABLE tasks; --";
    await createTasksRepository(db).list({ search: payload });

    const { sql, params } = db.calls[0];
    assert.doesNotMatch(sql, /DROP/i, 'the payload must not reach the statement text');
    assert.doesNotMatch(sql, /--/, 'no comment marker from the payload either');
    assert.match(sql, /title ILIKE \$1 ESCAPE/);
    assert.deepEqual(params, [`%${escapeLike(payload)}%`]);
    assert.equal(params[0].includes('DROP TABLE'), true, 'the value is passed as data');
  });

  test('a placeholder-looking search term is a value, not a reference', async () => {
    const db = recordingDb();
    await createTasksRepository(db).list({ search: '$1 OR 1=1' });

    assert.deepEqual(db.calls[0].params, ['%$1 OR 1=1%']);
    assert.equal(db.calls[0].sql.match(/\$1/g).length, 1, 'only the real placeholder appears once');
  });

  test('combining the done filter and the search filter renumbers the placeholders', async () => {
    const db = recordingDb();
    await createTasksRepository(db).list({ done: true, search: 'note' });

    assert.match(db.calls[0].sql, /WHERE done = \$1 AND title ILIKE \$2 ESCAPE/);
    assert.deepEqual(db.calls[0].params, [true, '%note%']);
  });

  test('read, write, update and delete all bind by position', async () => {
    const db = recordingDb();
    const tasks = createTasksRepository(db);

    await tasks.get(7);
    await tasks.create({ title: "O'Brien", done: false });
    await tasks.update(7, { title: 'x', done: true });
    await tasks.remove(7);

    assert.deepEqual(db.calls.map((call) => call.params), [[7], ["O'Brien", false], ['x', true, 7], [7]]);
    assert.match(db.calls[0].sql, /WHERE id = \$1$/);
    assert.match(db.calls[1].sql, /VALUES \(\$1, \$2\) RETURNING/);
    assert.match(db.calls[2].sql, /SET title = \$1, done = \$2 WHERE id = \$3/);
    assert.match(db.calls[3].sql, /DELETE FROM tasks WHERE id = \$1/);
  });

  test("a title containing a quote survives as data, which is the only proof that matters here", async () => {
    const db = recordingDb();
    await createTasksRepository(db).create({ title: `'); DROP TABLE tasks; --` });

    assert.equal(db.calls[0].params[0], `'); DROP TABLE tasks; --`);
    assert.doesNotMatch(db.calls[0].sql, /DROP/);
  });

  test('update can set one column, and the id always lands last', async () => {
    const db = recordingDb();
    const tasks = createTasksRepository(db);

    await tasks.update(9, { done: false });
    assert.match(db.calls[0].sql, /SET done = \$1 WHERE id = \$2/);
    assert.deepEqual(db.calls[0].params, [false, 9]);

    await tasks.update(9, {});
    assert.match(db.calls[1].sql, /^SELECT id, title, done FROM tasks WHERE id = \$1$/);
  });

  test('valuesClause builds exactly as many placeholders as it is given values', () => {
    assert.equal(valuesClause([['a', 1], ['b', 2], ['c', 3]], 2), '($1, $2), ($3, $4), ($5, $6)');
    assert.equal(valuesClause([['only']], 1), '($1)');
  });

  test('like wildcards typed into a search box are escaped, backslash first', () => {
    assert.equal(escapeLike('50%'), '50\\%');
    assert.equal(escapeLike('a_b'), 'a\\_b');
    assert.equal(escapeLike('already\\escaped'), 'already\\\\escaped');
    // Order matters: escaping the backslash after the others would escape the escape characters.
    assert.equal(escapeLike('\\%'), '\\\\\\%');
  });
});

describe('startup initialisation and reset', () => {
  test('the table is created with a generated id and Row Level Security switched on', async () => {
    const db = recordingDb();
    await createTasksRepository(db).ensureSchema();

    assert.match(db.calls[0].sql, /CREATE TABLE IF NOT EXISTS tasks/);
    assert.match(db.calls[0].sql, /GENERATED ALWAYS AS IDENTITY/);
    assert.match(db.calls[0].sql, /done\s+BOOLEAN/);
    assert.match(db.calls[1].sql, /ENABLE ROW LEVEL SECURITY/);
  });

  test('seeding locks the table before it counts, in one transaction', async () => {
    const db = recordingDb({ countValue: 0 });
    await createTasksRepository(db).initSeeds();

    const statements = db.calls.map((call) => call.sql);
    assert.match(statements[0], /^BEGIN$/);
    assert.match(statements[1], /^LOCK TABLE tasks IN SHARE ROW EXCLUSIVE MODE$/);
    assert.match(statements[2], /SELECT COUNT\(\*\)::int AS n FROM tasks$/);
    assert.match(statements[3], /^INSERT INTO tasks \(title, done\) VALUES/);
    assert.match(statements[4], /^COMMIT$/);
    assert.equal(db.calls[3].params.length, 6, 'three rows of title + done');
  });

  test('the lock comes before the count, because after it the count is already wrong', async () => {
    const db = recordingDb({ countValue: 0 });
    await createTasksRepository(db).initSeeds();

    const lockAt = db.calls.findIndex((call) => /^LOCK TABLE/.test(call.sql));
    const countAt = db.calls.findIndex((call) => /COUNT\(\*\)::int AS n/.test(call.sql));
    const insertAt = db.calls.findIndex((call) => /^INSERT INTO tasks/.test(call.sql));

    assert.ok(lockAt < countAt, 'a count taken before the lock can be raced by another writer');
    assert.ok(countAt < insertAt);
  });

  test('a table that already has rows is not seeded again', async () => {
    const db = recordingDb({ countValue: 3 });
    const seeded = await createTasksRepository(db).initSeeds();

    assert.equal(seeded, 0);
    assert.equal(db.calls.some((call) => /^INSERT INTO tasks/.test(call.sql)), false);
    assert.match(db.calls.at(-1).sql, /^COMMIT$/);
  });

  test('reset truncates with RESTART IDENTITY, then inserts the seeds', async () => {
    const db = recordingDb();
    const restored = await createTasksRepository(db).reset();

    assert.equal(restored, 3);
    assert.match(
      db.calls.map((call) => call.sql).find((sql) => /^TRUNCATE/.test(sql)),
      /TRUNCATE TABLE tasks RESTART IDENTITY/,
    );
  });

  test('init reports what it created, the way Week 3 printed it at startup', async () => {
    const db = recordingDb({ countValue: 0 });
    const report = await createTasksRepository(db).init();

    assert.deepEqual(Object.keys(report).sort(), ['seeded', 'total']);
    assert.equal(report.seeded, 3, 'the empty table was seeded');
    assert.match(db.calls[0].sql, /CREATE TABLE IF NOT EXISTS/, 'schema first');
    assert.match(db.calls.at(-1).sql, /COUNT\(\*\)::int AS n FROM tasks/, 'counted last');
  });

  test('a driver failure is renamed, and the statement that failed is not quoted back', async () => {
    const driverError = new Error('column "tasks.id" does not exist');
    driverError.detail = 'STATEMENT:  INSERT INTO tasks (title, done) VALUES (...)';
    const db = recordingDb({ failWith: driverError });
    const tasks = createTasksRepository(db);

    await assert.rejects(() => tasks.create({ title: 'x' }), (error) => {
      assert.ok(error instanceof DatabaseError);
      assert.match(error.message, /^could not create task: column "tasks\.id" does not exist$/);
      assert.equal(error.message.includes('STATEMENT'), false, 'pg puts the SQL in .detail, not .message');
      assert.equal(error.cause, driverError, 'the real error is kept for the log');
      return true;
    });
  });
});
