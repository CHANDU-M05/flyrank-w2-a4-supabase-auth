// The middleware as a shared gate, and the route that spends a verified identity to sign it out.
//
// Two claims to hold apart here. That /auth/logout and /protected/dashboard behave like
// /protected/profile is a unit-testable claim: same fake, same header rules, same refusals, one
// provider call each. Whether signing out actually kills the access token it was issued with is NOT:
// our app stores no session, so the answer belongs to GoTrue, and picking a fake that revokes (or
// doesn't) would just be choosing the result in advance. That question is measured against the real
// local Supabase and the answer goes in the README — which is what §4.E asks for instead of a
// confident claim.
const assert = require('node:assert/strict');
const { after, describe, test } = require('node:test');

const {
  FAKE_ACCESS_TOKEN,
  FAKE_USER_ID,
  authError,
  createFakeSignOut,
  createFakeSupabase,
  fakeUser,
} = require('./helpers/fake-supabase');
const { createFakeTasks } = require('./helpers/fake-tasks');
const { bearer, closeAllTestServers, startTestApp } = require('./helpers/server');

after(closeAllTestServers);

// A client that vouches for any token, giving back the provider's whole user object so the routes get
// a real chance to over-return.
const verifyAll = () => ({ data: { user: fakeUser() }, error: null });

async function protectedApp({ getUser = verifyAll, signOut = createFakeSignOut(), supabase = null } = {}) {
  const client = supabase ?? createFakeSupabase({ getUser });
  const log = [];
  const app = await startTestApp({
    tasks: createFakeTasks(),
    supabase: client,
    signOut,
    log: (line) => log.push(line),
  });
  return { app, client, signOut, log };
}

describe('the middleware protects every route the same way', () => {
  test('GET /protected/dashboard refuses a caller with no token, and asks the provider nothing', async () => {
    const { app, client } = await protectedApp();

    const response = await app.get('/protected/dashboard');

    assert.equal(response.status, 401);
    assert.deepEqual(response.body, { error: 'Access token required' });
    assert.deepEqual(client.methods(), [], 'a missing header is not worth a network call');
    await app.close();
  });

  test('a token refused on /protected/profile is refused on /protected/dashboard with the same body', async () => {
    // The reuse claim, tested rather than asserted: both routes answer through one middleware, so
    // there is no second copy of the rules that could drift into a different wording or status.
    const rejecting = createFakeSupabase({
      getUser: () => ({ data: { user: null }, error: authError({ code: 'bad_jwt', status: 403, message: 'token expired' }) }),
    });
    const { app } = await protectedApp({ supabase: rejecting });

    const profile = await app.get('/protected/profile', { authorization: bearer('expired-token') });
    const dashboard = await app.get('/protected/dashboard', { authorization: bearer('expired-token') });

    assert.equal(profile.status, 401);
    assert.equal(dashboard.status, 401);
    assert.equal(profile.text, dashboard.text, 'two routes, one answer');
    await app.close();
  });

  test('a verified token gets a dashboard, and it carries the id and no identity nobody asked for', async () => {
    const { app } = await protectedApp();

    const response = await app.get('/protected/dashboard', { authorization: bearer('any-token') });

    assert.equal(response.status, 200);
    assert.deepEqual(Object.keys(response.body).sort(), ['message', 'userId']);
    assert.equal(response.body.userId, FAKE_USER_ID);
    // `fakeUser` has an email, a phone and an `encrypted_password` on it. A dashboard greeting that
    // spread `request.user` would put them all in the body.
    for (const absent of [fakeUser().email, '+15550001234', '$2a$FAKE']) {
      assert.equal(response.text.includes(absent), false, `dashboard leaked ${absent}`);
    }
    await app.close();
  });

  test('one request to a protected route costs exactly one call to the provider', async () => {
    // If verification still lived in the handler as well as the middleware, a single GET would ask
    // `getUser` twice. The count is the proof that the logic was moved rather than copied.
    const { app, client } = await protectedApp();

    await app.get('/protected/dashboard', { authorization: bearer('one-token') });

    assert.deepEqual(client.methods(), ['getUser']);
    await app.close();
  });

  test('the two protected routes agree about who the caller is', async () => {
    const tokenDeriving = createFakeSupabase({
      getUser: (token) => ({ data: { user: fakeUser({ id: `id-for-${token}` }) }, error: null }),
    });
    const { app } = await protectedApp({ supabase: tokenDeriving });

    const profile = await app.get('/protected/profile', { authorization: bearer('carol') });
    const dashboard = await app.get('/protected/dashboard', { authorization: bearer('carol') });

    assert.equal(profile.body.id, 'id-for-carol');
    assert.equal(dashboard.body.userId, 'id-for-carol');
    await app.close();
  });

  test('the public and credential-exchanging routes are still outside the gate', async () => {
    const { app, client } = await protectedApp();

    const info = await app.get('/public/info');
    const login = await app.post('/auth/login', { email: 'reader@example.com', password: 'correct-horse-battery' });

    assert.equal(info.status, 200);
    assert.equal(login.status, 200);
    assert.deepEqual(client.methods(), ['signInWithPassword'], 'no token verification on either');
    await app.close();
  });

  test('with no client, the dashboard keeps the 401-before-503 order profile uses', async () => {
    const unconfigured = await startTestApp({ tasks: createFakeTasks(), supabase: null });

    const noToken = await unconfigured.get('/protected/dashboard');
    const withToken = await unconfigured.get('/protected/dashboard', { authorization: bearer('any-token') });

    assert.deepEqual(noToken.body, { error: 'Access token required' });
    assert.deepEqual(withToken.body, { error: 'authentication is not configured' });
    assert.equal(withToken.status, 503);
    await unconfigured.close();
  });
});

describe('POST /auth/logout', () => {
  test('requires authentication: nothing in the header means 401 and no sign-out call', async () => {
    const signOut = createFakeSignOut();
    const { app } = await protectedApp({ signOut });

    const response = await app.post('/auth/logout', {}, { authorization: undefined });

    assert.equal(response.status, 401);
    assert.deepEqual(response.body, { error: 'Access token required' });
    assert.equal(signOut.calls.length, 0, 'a caller we could not identify must not reach the provider');
    await app.close();
  });

  test('a token the provider will not vouch for is refused before any sign-out', async () => {
    // The order matters more than it looks: signing out on someone's say-so, for a caller who never
    // proved identity, would let anyone end a session by guessing a token's shape.
    const signOut = createFakeSignOut();
    const rejecting = createFakeSupabase({
      getUser: () => ({ data: { user: null }, error: authError({ code: 'bad_jwt', status: 403, message: 'bad' }) }),
    });
    const { app } = await protectedApp({ supabase: rejecting, signOut });

    const response = await app.post('/auth/logout', {}, { authorization: bearer('forged-token') });

    assert.equal(response.status, 401);
    assert.deepEqual(response.body, { error: 'Invalid or expired token' });
    assert.equal(signOut.calls.length, 0);
    await app.close();
  });

  test('success is a 204 with no body at all', async () => {
    const signOut = createFakeSignOut();
    const { app } = await protectedApp({ signOut });

    const response = await app.post('/auth/logout', {}, { authorization: bearer(FAKE_ACCESS_TOKEN) });

    assert.equal(response.status, 204);
    assert.equal(response.text, '', 'a 204 with a body is malformed HTTP');
    assert.equal(response.body, null);
    assert.equal(response.headers.get('content-length'), null, 'and it should not claim a length');
    assert.equal(signOut.calls.length, 1);
    await app.close();
  });

  test('it signs out the caller who asked, not whoever the client last saw', async () => {
    // §4.E's whole point. A shared client would sign out "the session", which on a server is nobody or
    // the last person who logged in; the two requests below must spend their own bearer tokens.
    const signOut = createFakeSignOut();
    const byToken = createFakeSupabase({
      getUser: (token) => ({ data: { user: fakeUser({ id: `id-for-${token}` }) }, error: null }),
    });
    const { app } = await protectedApp({ supabase: byToken, signOut });

    const alice = await app.post('/auth/logout', {}, { authorization: bearer('alice-token') });
    const bob = await app.post('/auth/logout', {}, { authorization: bearer('bob-token') });

    assert.equal(alice.status, 204);
    assert.equal(bob.status, 204);
    assert.deepEqual(
      signOut.calls.map((call) => call.accessToken),
      ['alice-token', 'bob-token'],
      'each sign-out carries its own request token',
    );
    await app.close();
  });

  test('a sign-out the provider refuses is never reported as a success', async () => {
    // The tempting shortcut is to answer 204 whatever happens, since the caller wanted to be logged out
    // anyway. That tells someone their session ended while it is still live — on a shared computer, the
    // difference between a lie and a warning.
    for (const [status, expected] of [
      [500, { status: 502, error: 'sign-out could not be completed' }],
      [429, { status: 502, error: 'sign-out could not be completed' }],
      [401, { status: 401, error: 'Invalid or expired token' }],
      [403, { status: 401, error: 'Invalid or expired token' }],
    ]) {
      const { app } = await protectedApp({ signOut: createFakeSignOut({ failWith: status }) });

      const response = await app.post('/auth/logout', {}, { authorization: bearer('live-token') });

      assert.equal(response.status, expected.status, `provider ${status} -> our ${expected.status}`);
      assert.deepEqual(response.body, { error: expected.error });
      await app.close();
    }
  });

  test("an unreachable provider is 502, and the failure's own words stay out of the body", async () => {
    const { app } = await protectedApp({
      signOut: createFakeSignOut({
        failWith: () => Object.assign(new Error('fetch failed: ECONNREFUSED 127.0.0.1:54321'), { name: 'TypeError' }),
      }),
    });

    const response = await app.post('/auth/logout', {}, { authorization: bearer('live-token') });

    assert.equal(response.status, 502);
    assert.deepEqual(response.body, { error: 'authentication service is unreachable' });
    // The cause names our internal host and port. None of it leaves the process.
    assert.equal(response.text.includes('54321'), false);
    assert.equal(response.text.includes('ECONNREFUSED'), false);
    await app.close();
  });

  test('a server with no sign-out wired answers 503 to a verified caller and 401 to an anonymous one', async () => {
    const app = await startTestApp({ tasks: createFakeTasks(), supabase: createFakeSupabase({ getUser: verifyAll }) });

    const noToken = await app.post('/auth/logout');
    const verified = await app.post('/auth/logout', {}, { authorization: bearer('good-token') });

    assert.deepEqual(noToken.body, { error: 'Access token required' });
    assert.equal(noToken.status, 401);
    assert.deepEqual(verified.body, { error: 'sign-out is not configured' });
    assert.equal(verified.status, 503);
    await app.close();
  });

  test('the token never reaches the request log, the response body, or an error message', async () => {
    // One test with three places to look, because the leak that matters is the one nobody thought to
    // check: the log line this app writes for every request.
    const signOut = createFakeSignOut({ failWith: 500 });
    const { app, log } = await protectedApp({ signOut });
    const token = 'do-not-log-me-4d1f1f';

    const response = await app.post('/auth/logout', {}, { authorization: bearer(token) });

    assert.equal(response.status, 502);
    assert.equal(response.text.includes(token), false, 'response body');
    assert.equal(signOut.calls[0].accessToken, token, 'the fake still got it, so the check is real');
    assert.equal(log.join('\n').includes(token), false, 'request log');
    assert.equal(log.some((line) => /authorization/i.test(line)), false, 'and no header names either');
    await app.close();
  });
});

describe('the root document keeps up', () => {
  test('it lists the two routes Stage 4 added', async () => {
    const { app } = await protectedApp();

    const root = await app.get('/');

    assert.ok(root.body.endpoints.includes('GET /protected/dashboard'), 'dashboard listed');
    assert.ok(root.body.endpoints.includes('POST /auth/logout'), 'logout listed');
    await app.close();
  });
});
