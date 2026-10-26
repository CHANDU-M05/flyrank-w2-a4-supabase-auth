// The gate, before it verifies anything.
//
// Stage 2 is deliberately half-built, and these tests are what keeps that honest rather than
// dangerous: they pin down every header shape that must be refused, and they assert that the route
// which a *shaped-but-unverified* token can reach returns nothing about anyone. When Stage 3 adds real
// verification, the test that says "a made-up token gets through" is the one that has to change.
const assert = require('node:assert/strict');
const { after, before, describe, test } = require('node:test');

const { HttpError } = require('../src/errors');
const { readBearer } = require('../src/http');
const { createFakeTasks } = require('./helpers/fake-tasks');
const { closeAllTestServers, startTestApp } = require('./helpers/server');

after(closeAllTestServers);

const header = (value) => ({ headers: value === undefined ? {} : { authorization: value } });

describe('reading a bearer token out of a header', () => {
  test('every shape that is not a bearer token is refused the same way', () => {
    const refused = [undefined, '', '   ', 'Bearer', 'Bearer   ', 'Basic YWxpY2U6', 'Token abc123', 'abc123'];

    for (const value of refused) {
      assert.throws(
        () => readBearer(header(value)),
        (error) => {
          assert.ok(error instanceof HttpError);
          assert.equal(error.status, 401);
          assert.equal(error.message, 'Access token required');
          return true;
        },
        `readBearer(${JSON.stringify(value)})`,
      );
    }
  });

  test('a scheme is case-insensitive and padding is not part of the token', () => {
    assert.equal(readBearer(header('Bearer abc123')), 'abc123');
    assert.equal(readBearer(header('bearer abc123')), 'abc123');
    assert.equal(readBearer(header('BEARER abc123')), 'abc123');
    assert.equal(readBearer(header('  Bearer abc123  ')), 'abc123');
    assert.equal(readBearer(header('Bearer\tabc123')), 'abc123');
  });

  test('two values in one header is not a token, and a duplicated header is not a bearer either', () => {
    // `Bearer a b` is one header carrying two things. Node also turns a repeated Authorization header
    // into an *array*, which is the shape an attacker would hope a framework concatenates into
    // something it recognises. Neither is accepted.
    assert.throws(() => readBearer(header('Bearer abc def')), /Access token required/);
    assert.throws(() => readBearer({ headers: { authorization: ['Bearer abc', 'Bearer def'] } }), /Access token required/);
  });

  test('the refusal never repeats the token it refused', () => {
    const secret = 'a-real-looking-token-value';
    try {
      readBearer(header(`Basic ${secret}`));
      assert.fail('expected a refusal');
    } catch (error) {
      assert.equal(error.message.includes(secret), false);
    }
  });
});

describe('GET /public/info needs nothing', () => {
  let app;

  before(async () => {
    app = await startTestApp({ tasks: createFakeTasks() });
  });

  after(async () => {
    await app.close();
  });

  test('the public answer, word for word as §4.C specifies it', async () => {
    const response = await app.get('/public/info');

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { message: 'Welcome stranger! This info is public.' });
  });

  test('no Authorization header is consulted on this route at all', async () => {
    const withJunkToken = await app.get('/public/info', { authorization: 'Bearer not-a-real-token' });
    const withBasic = await app.get('/public/info', { authorization: 'Basic YWxpY2U6c2VjcmV0' });

    assert.equal(withJunkToken.status, 200);
    assert.equal(withBasic.status, 200, 'public means public; a bad token must not become a 401 here');
  });
});

describe('GET /protected/profile', () => {
  let app;

  before(async () => {
    app = await startTestApp({ tasks: createFakeTasks() });
  });

  after(async () => {
    await app.close();
  });

  test('nothing in the header means 401 and no body beyond the error', async () => {
    const response = await app.get('/protected/profile');

    assert.equal(response.status, 401);
    assert.deepEqual(response.body, { error: 'Access token required' });
  });

  test('the wrong scheme and the empty token are refused identically', async () => {
    const noScheme = await app.get('/protected/profile', { authorization: 'not-a-bearer-at-all' });
    const basic = await app.get('/protected/profile', { authorization: 'Basic YWxpY2U6c2VjcmV0' });
    const empty = await app.get('/protected/profile', { authorization: 'Bearer ' });

    for (const response of [noScheme, basic, empty]) {
      assert.equal(response.status, 401);
      assert.deepEqual(response.body, { error: 'Access token required' });
    }
  });

  test('what a merely well-shaped token can reach at Stage 2, and what it cannot', async () => {
    const response = await app.get('/protected/profile', { authorization: 'Bearer made-up-token-12345' });

    assert.equal(response.status, 200, 'this is the gap Stage 3 closes: format is not verification');
    assert.deepEqual(response.body, { reachable: true, verified: false });
    assert.doesNotMatch(response.text, /eyJ/, 'no token material echoed back');
    assert.equal(Object.keys(response.body).length, 2, 'and nothing else in the body');
  });

  test('a path under /protected that does not exist is a 404, not an invitation to guess', async () => {
    const response = await app.get('/protected/admin', { authorization: 'Bearer made-up-token-12345' });

    assert.equal(response.status, 404);
    assert.deepEqual(response.body, { error: 'GET /protected/admin not found' });
  });
});

describe('the two routes side by side', () => {
  test('the root document lists both, and says which one is public', async () => {
    const app = await startTestApp({ tasks: createFakeTasks() });

    const root = await app.get('/');

    assert.ok(root.body.endpoints.includes('GET /public/info'));
    assert.ok(root.body.endpoints.includes('GET /protected/profile'));
    await app.close();
  });

  test('adding these did not move the task routes or the auth routes', async () => {
    const app = await startTestApp({ tasks: createFakeTasks() });

    const tasks = await app.get('/tasks');
    const login = await app.post('/auth/login', { email: 'reader@example.com', password: 'x' });

    assert.equal(tasks.status, 200);
    assert.equal(tasks.body.length, 3);
    assert.equal(login.status, 503, 'auth still answers 503 with no client, not 404 behind the new mounts');
    await app.close();
  });
});
