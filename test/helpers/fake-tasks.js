// An in-memory stand-in for the tasks repository, used by the unit tests so that HTTP behaviour can
// be exercised with no database and no network.
//
// It mirrors the *documented* behaviour of the real one, including the two details that are easy to
// lose in a fake: an id the server hands out is never reused, and after a reset the next id is 4
// again because the sequence is rewound with the rows. A fake that ignores those would let a route
// change pass the tests while breaking the contract.
//
// It does NOT try to reproduce SQL semantics: `search` here is a plain case-insensitive substring,
// so the LIKE-wildcard escaping is not tested by this file. That is tested against real Postgres in
// test/integration/, which is the only place the claim can actually be checked.
const { SEEDS } = require('../../src/db/schema');
const { DatabaseError } = require('../../src/errors');

function createFakeTasks({ seeds = SEEDS, failWith = null } = {}) {
  const clone = (rows) => rows.map((row) => ({ ...row }));
  let rows = clone(seeds).map((row, index) => ({ id: index + 1, title: row.title, done: row.done }));
  let nextId = rows.length + 1;
  let reachable = true;
  const calls = [];

  // Lets a test put the repository into a known failure state: `failWith = 'connection refused'`
  // makes every call throw the way the driver would, and the real repository wraps driver errors in
  // DatabaseError before they reach HTTP, so the fake produces the same type — otherwise the test
  // would be exercising the wrong handler.
  const guard = (action) => {
    calls.push(action);
    if (!reachable || failWith) {
      throw new DatabaseError(`${action}: ${failWith || 'database went away'}`);
    }
  };

  return {
    calls,
    setReachable(value) {
      reachable = value;
    },

    async ping() {
      return reachable && !failWith;
    },

    async list({ done, search } = {}) {
      guard('list');
      let result = rows;
      if (done !== undefined && done !== null) result = result.filter((row) => row.done === done);
      if (search) {
        const needle = search.toLowerCase();
        result = result.filter((row) => row.title.toLowerCase().includes(needle));
      }
      return clone(result).sort((a, b) => a.id - b.id);
    },

    async get(id) {
      guard('get');
      const found = rows.find((row) => row.id === id);
      return found ? { ...found } : null;
    },

    async create({ title, done = false }) {
      guard('create');
      const row = { id: nextId, title, done };
      nextId += 1;
      rows.push(row);
      return { ...row };
    },

    async update(id, { title, done }) {
      guard('update');
      const row = rows.find((candidate) => candidate.id === id);
      if (!row) return null;
      if (title !== undefined) row.title = title;
      if (done !== undefined) row.done = done;
      return { ...row };
    },

    async remove(id) {
      guard('remove');
      const before = rows.length;
      rows = rows.filter((row) => row.id !== id);
      return rows.length < before;
    },

    async stats() {
      guard('stats');
      const done = rows.filter((row) => row.done).length;
      return { total: rows.length, done, open: rows.length - done };
    },

    async reset() {
      guard('reset');
      rows = clone(seeds).map((row, index) => ({ id: index + 1, title: row.title, done: row.done }));
      nextId = rows.length + 1;
      return rows.length;
    },
  };
}

module.exports = { createFakeTasks };
