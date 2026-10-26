// The gate: which header shapes are accepted, and what happens when there is nothing to verify
// against.
//
// Stage 2 let any well-shaped bearer through and returned a body that named nobody. Stage 3 put
// `supabase.auth.getUser()` behind it, so the test that used to assert "a made-up token gets through"
// now asserts the opposite — it is kept here rather than deleted because the shape of the request that
// changed is the point. What a *verified* token returns lives in test/unit.token-verification.test.js;
// this file is only about the header and the gate.
//
// Stage 4 moved that gate into src/middleware/auth.js without changing any of these answers — which is
// itself worth testing: if the middleware were wired in a different order, or asked the provider about
// something other than the header it was given, the assertions below would move.
const assert = require('node:assert/strict');
const { after, before, beforeEach, describe, test } = require('node:test');

const { HttpError } = require('../src/errors');
const { readBearer } = require('../src/http');
const { createFakeSupabase, fakeUser } = require('./helpers/fake-supabase');
const { createFakeTasks } = require('./helpers/fake-tasks');
const { bearer, closeAllTestServers, startTestApp } = require('./helpers/server');

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
  let supabase;

  before(async () => {
    // The default fake answers `getUser` with no user and no error, which is a shape no successful
    // verification produces. So every request that gets past the header check in this suite is
    // refused — which is exactly what these tests are about.
    supabase = createFakeSupabase();
    app = await startTestApp({ tasks: createFakeTasks(), supabase });
  });

  beforeEach(() => {
    supabase.clear();
  });

  after(async () => {
    await app.close();
  });

  test('nothing in the header means 401 and no body beyond the error', async () => {
    const response = await app.get('/protected/profile');

    assert.equal(response.status, 401);
    assert.deepEqual(response.body, { error: 'Access token required' });
    assert.deepEqual(supabase.methods(), [], 'a request with no token must not cost a call to the provider');
  });

  test('the wrong scheme and the empty token are refused identically', async () => {
    const noScheme = await app.get('/protected/profile', { authorization: 'not-a-bearer-at-all' });
    const basic = await app.get('/protected/profile', { authorization: 'Basic YWxpY2U6c2VjcmV0' });
    const empty = await app.get('/protected/profile', { authorization: 'Bearer ' });

    for (const response of [noScheme, basic, empty]) {
      assert.equal(response.status, 401);
      assert.deepEqual(response.body, { error: 'Access token required' });
    }
    assert.deepEqual(supabase.methods(), [], 'and none of them reached Supabase either');
  });

  test('a token that is merely well-shaped is refused, which is what Stage 3 changed', async () => {
    const response = await app.get('/protected/profile', { authorization: 'Bearer made-up-token-12345' });

    assert.equal(response.status, 401, 'format is not verification');
    assert.deepEqual(response.body, { error: 'Invalid or expired token' });
    assert.deepEqual(supabase.methods(), ['getUser'], 'this time the provider was asked');
    // `getUser(jwt)` takes the token as its one positional argument, so that is what the fake recorded.
    assert.equal(supabase.inputFor('getUser'), 'made-up-token-12345', 'asked about the token sent');
  });

  test('an unknown path under /protected is refused for the wrong-token reason, not answered 404', async () => {
    // Stage 4 changed this answer. The middleware is mounted over the whole prefix, so a caller whose
    // token does not verify never learns whether /protected/nope exists — which is the safer order
    // (an unauthenticated probe cannot use 404-vs-401 to map the API) and the price is that a
    // legitimate-looking 404 turns into a 401 for someone who is not identified anyway.
    const response = await app.get('/protected/nope', { authorization: 'Bearer made-up-token-12345' });

    assert.equal(response.status, 401);
    assert.deepEqual(response.body, { error: 'Invalid or expired token' });
  });

  test('but a verified caller still gets an honest 404 for a path that does not exist', async () => {
    // The other half of that trade, and the reason the first test alone would not be enough: refusing
    // everything under the prefix would make a typo in `/protected/profil` look like an auth problem
    // forever. Verification first, then the ordinary routing miss.
    const verifying = createFakeSupabase({
      getUser: () => ({ data: { user: fakeUser() }, error: null }),
    });
    const configured = await startTestApp({ tasks: createFakeTasks(), supabase: verifying });

    const response = await configured.get('/protected/nope', { authorization: bearer('a-real-token') });

    assert.equal(response.status, 404);
    assert.deepEqual(response.body, { error: 'GET /protected/nope not found' });
    await configured.close();
  });

  test('with no client, a caller who sent nothing is still refused for sending nothing', async () => {
    const unconfigured = await startTestApp({ tasks: createFakeTasks(), supabase: null });

    const noToken = await unconfigured.get('/protected/profile');
    const shapedToken = await unconfigured.get('/protected/profile', { authorization: 'Bearer made-up-token-12345' });

    assert.deepEqual(noToken.body, { error: 'Access token required' }, 'their problem, whatever ours is');
    assert.equal(noToken.status, 401);
    assert.deepEqual(shapedToken.body, { error: 'authentication is not configured' });
    assert.equal(
      shapedToken.status,
      503,
      'a caller holding a real token is not told it is invalid when we cannot check it',
    );
    await unconfigured.close();
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
