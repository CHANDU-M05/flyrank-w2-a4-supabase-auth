// The task contract from Weeks 2 and 3, asserted against the Express app with no database in sight.
//
// These tests own the HTTP-facing promises: paths, status codes, JSON shapes, the one error
// envelope, and the 204-with-no-body rule. They use the in-memory repository, so a failure here is
// always about routing and validation, never about Postgres. The real SQL is covered by
// test/integration/, which needs the local Supabase running.
const assert = require('node:assert/strict');
const { after, before, describe, test } = require('node:test');

const { createFakeTasks } = require('./helpers/fake-tasks');
const { startTestApp } = require('./helpers/server');

describe('task CRUD contract (Express port of Weeks 2 and 3)', () => {
  let app;
  let tasks;

  before(async () => {
    tasks = createFakeTasks();
    app = await startTestApp({ tasks });
  });

  after(async () => {
    await app.close();
  });

  test('GET /tasks returns the seeded tasks in id order', async () => {
    const response = await app.get('/tasks');

    assert.equal(response.status, 200);
    assert.deepEqual(
      response.body.map((task) => task.id),
      [1, 2, 3],
    );
    assert.deepEqual(Object.keys(response.body[0]).sort(), ['done', 'id', 'title']);
  });

  test('GET /tasks?done=true returns only finished tasks', async () => {
    const response = await app.get('/tasks?done=true');

    assert.equal(response.status, 200);
    assert.deepEqual(
      response.body.map((task) => task.id),
      [1],
    );
  });

  test('GET /tasks?done=false returns only open tasks', async () => {
    const response = await app.get('/tasks?done=false');

    assert.deepEqual(
      response.body.map((task) => task.id),
      [2, 3],
    );
  });

  test('GET /tasks?done=banana is a 400, not a silently ignored filter', async () => {
    const response = await app.get('/tasks?done=banana');

    assert.equal(response.status, 400);
    assert.deepEqual(response.body, { error: 'done must be true or false' });
  });

  test('GET /tasks?search= matches case-insensitively', async () => {
    const response = await app.get('/tasks?search=SERVER');

    assert.equal(response.status, 200);
    assert.equal(response.body.length, 1);
    assert.match(response.body[0].title, /server/i);
  });

  test('GET /tasks/:id returns that task', async () => {
    const response = await app.get('/tasks/1');

    assert.equal(response.status, 200);
    assert.equal(response.body.id, 1);
  });

  test('GET /tasks/:id for an unknown id is a 404 in the error envelope', async () => {
    const response = await app.get('/tasks/999999');

    assert.equal(response.status, 404);
    assert.deepEqual(response.body, { error: 'Task 999999 not found' });
  });

  test('GET /tasks/not-a-number is a 400 about the id, not a 404 about a task', async () => {
    const response = await app.get('/tasks/not-a-number');

    assert.equal(response.status, 400);
    assert.deepEqual(response.body, { error: 'invalid id: must be a positive integer' });
  });

  test('GET /tasks/0 is a 400 — zero can never name a row', async () => {
    const response = await app.get('/tasks/0');

    assert.equal(response.status, 400);
  });

  test('POST /tasks creates and answers 201 with the stored row', async () => {
    const response = await app.post('/tasks', { title: 'Buy milk' });

    assert.equal(response.status, 201);
    assert.deepEqual(response.body, { id: 4, title: 'Buy milk', done: false });

    const list = await app.get('/tasks');
    assert.equal(list.body.length, 4);
  });

  test('POST /tasks keeps a done flag the client sent', async () => {
    const response = await app.post('/tasks', { title: 'Already finished', done: true });

    assert.equal(response.status, 201);
    assert.equal(response.body.done, true);
  });

  test('POST /tasks with no title is a 400 saying what is missing', async () => {
    const response = await app.post('/tasks', {});

    assert.equal(response.status, 400);
    assert.deepEqual(response.body, { error: 'title is required' });
  });

  test('POST /tasks with a whitespace title is a 400', async () => {
    const response = await app.post('/tasks', { title: '   ' });

    assert.equal(response.status, 400);
    assert.deepEqual(response.body, { error: 'title must be a non-empty string' });
  });

  test('POST /tasks with a non-string title is a 400, not a type coercion', async () => {
    for (const title of [42, true, [], {}, ['x']]) {
      const response = await app.post('/tasks', { title });

      assert.equal(response.status, 400, `title ${JSON.stringify(title)} should be rejected`);
      assert.deepEqual(response.body, { error: 'title must be a non-empty string' });
    }
  });

  test('POST /tasks with title: null is reported as missing, not as the wrong type', async () => {
    const response = await app.post('/tasks', { title: null });

    assert.equal(response.status, 400);
    assert.deepEqual(response.body, { error: 'title is required' });
  });

  test('POST /tasks trims the title rather than storing padding', async () => {
    const response = await app.post('/tasks', { title: '  Padded  ' });

    assert.equal(response.status, 201);
    assert.equal(response.body.title, 'Padded');
  });

  test('POST /tasks with a body that is not an object is a 400', async () => {
    const response = await app.post('/tasks', ['not', 'an', 'object']);

    assert.equal(response.status, 400);
    assert.deepEqual(response.body, { error: 'request body must be a JSON object' });
  });

  test('POST /tasks with malformed JSON is a 400 about the JSON', async () => {
    const response = await app.call('POST', '/tasks', { body: '{"title": "unterminated' });

    assert.equal(response.status, 400);
    assert.deepEqual(response.body, { error: 'request body must be valid JSON' });
  });

  test('PUT /tasks/:id changes the title and answers 200 with the new row', async () => {
    const response = await app.put('/tasks/2', { title: 'Renamed by test' });

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { id: 2, title: 'Renamed by test', done: false });

    const reread = await app.get('/tasks/2');
    assert.equal(reread.body.title, 'Renamed by test');
  });

  test('PUT /tasks/:id can set done on its own', async () => {
    const response = await app.put('/tasks/3', { done: true });

    assert.equal(response.status, 200);
    assert.equal(response.body.done, true);
  });

  test('PUT /tasks/:id with an empty body is a 400 — an empty update is not a no-op', async () => {
    const response = await app.put('/tasks/1', {});

    assert.equal(response.status, 400);
    assert.deepEqual(response.body, { error: 'send at least one of title or done' });
  });

  test('PUT /tasks/:id on an unknown id is a 404', async () => {
    const response = await app.put('/tasks/999999', { title: 'Nothing here' });

    assert.equal(response.status, 404);
    assert.deepEqual(response.body, { error: 'Task 999999 not found' });
  });

  test('PUT /tasks/:id with done: "yes" is a 400, not a truthy string', async () => {
    const response = await app.put('/tasks/1', { done: 'yes' });

    assert.equal(response.status, 400);
    assert.deepEqual(response.body, { error: 'done must be true or false' });
  });

  test('DELETE /tasks/:id answers 204 and sends no body at all', async () => {
    const created = await app.post('/tasks', { title: 'Doomed' });
    const response = await app.del(`/tasks/${created.body.id}`);

    assert.equal(response.status, 204);
    assert.equal(response.text, '');
    assert.equal(response.headers.get('content-length'), null);
  });

  test('DELETE /tasks/:id twice is a 404 the second time', async () => {
    const created = await app.post('/tasks', { title: 'Doomed twice' });
    await app.del(`/tasks/${created.body.id}`);
    const again = await app.del(`/tasks/${created.body.id}`);

    assert.equal(again.status, 404);
    assert.deepEqual(again.body, { error: `Task ${created.body.id} not found` });
  });

  test('DELETE /tasks/:id on an unknown id is a 404', async () => {
    const response = await app.del('/tasks/999999');

    assert.equal(response.status, 404);
  });

  test('a deleted id is never handed out again', async () => {
    const first = await app.post('/tasks', { title: 'First' });
    await app.del(`/tasks/${first.body.id}`);
    const second = await app.post('/tasks', { title: 'Second' });

    assert.notEqual(second.body.id, first.body.id);
    assert.ok(second.body.id > first.body.id);
  });

  test('GET /stats counts in the shape documented since Week 2', async () => {
    const response = await app.get('/stats');

    assert.equal(response.status, 200);
    assert.deepEqual(Object.keys(response.body).sort(), ['done', 'open', 'total']);
    assert.equal(response.body.total, response.body.done + response.body.open);
  });

  test('POST /reset puts the three seeds back and rewinds the ids', async () => {
    const response = await app.post('/reset', {});

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { restored: 3 });

    const list = await app.get('/tasks');
    assert.deepEqual(
      list.body.map((task) => task.id),
      [1, 2, 3],
    );

    // Week 2 documented that the first task after a reset is id 4, which is what
    // TRUNCATE ... RESTART IDENTITY buys. An id that kept climbing would be a quieter change than
    // it sounds like, so it is asserted rather than assumed.
    const created = await app.post('/tasks', { title: 'After reset' });
    assert.equal(created.body.id, 4);

    await app.post('/reset', {});
  });

  test('GET /health answers ok while the database answers', async () => {
    const response = await app.get('/health');

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { status: 'ok' });
  });

  test('GET /health answers 503 in the same envelope when the database does not', async () => {
    const broken = await startTestApp({ tasks: createFakeTasks({ failWith: 'connection refused' }) });
    try {
      const response = await broken.get('/health');

      assert.equal(response.status, 503);
      assert.deepEqual(response.body, { error: 'database unreachable' });
    } finally {
      await broken.close();
    }
  });

  test('a database failure becomes a 500 in the error envelope, with no stack trace', async () => {
    const tasksDown = createFakeTasks();
    const broken = await startTestApp({ tasks: tasksDown });
    try {
      tasksDown.setReachable(false);
      const response = await broken.get('/tasks');

      assert.equal(response.status, 500);
      assert.match(response.body.error, /^database error: /);
      assert.doesNotMatch(response.text, /at \w+.*\(.*:\d+:\d+\)/, 'a stack frame must not escape');
      assert.doesNotMatch(response.text, /DatabaseError/);
    } finally {
      await broken.close();
    }
  });

  test('an unknown route is a JSON 404, not Express HTML', async () => {
    const response = await app.get('/nowhere');

    assert.equal(response.status, 404);
    assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.deepEqual(response.body, { error: 'GET /nowhere not found' });
  });

  test('the server does not advertise the framework it runs on', async () => {
    const response = await app.get('/tasks');

    assert.equal(response.headers.get('x-powered-by'), null);
  });

  test('the root route describes the API without naming any credential', async () => {
    const response = await app.get('/');

    assert.equal(response.status, 200);
    assert.equal(response.body.store, 'postgres');
    assert.ok(response.body.endpoints.includes('GET /tasks'));
    assert.doesNotMatch(response.text, /key|token|password|secret/i);
  });

  test('a body larger than the parser allows is refused, not buffered', async () => {
    const response = await app.post('/tasks', { title: 'x'.repeat(40 * 1024) });

    assert.equal(response.status, 413);
  });
});
