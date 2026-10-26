// Token verification: what `supabase.auth.getUser()` has to say before this API will name anyone.
//
// Stage 3's whole claim is that an identity is answered from a verified token and never from the
// header's appearance. Each test below is one way that claim could be false, with the interesting one
// being the pair "the provider was unreachable" and "the token was bad" — a route that answers 401 for
// both is a route whose users log out and back in forever while the outage continues.
const assert = require('node:assert/strict');
const { after, describe, test } = require('node:test');

const {
  FAKE_ACCESS_TOKEN,
  authError,
  createFakeSupabase,
  fakeUser,
  sessionMissingError,
} = require('./helpers/fake-supabase');
const { createFakeTasks } = require('./helpers/fake-tasks');
const { bearer, closeAllTestServers, startTestApp } = require('./helpers/server');

after(closeAllTestServers);

// A fake that verifies any token by inventing a user named after it. Two requests with two tokens get
// two identities, which is what makes the isolation test below possible.
const verifyEverything = (token) => ({
  data: { user: fakeUser({ id: `user-for-${token}`, email: `${token}@verified.test` }) },
  error: null,
});

async function appWith(getUser) {
  const supabase = createFakeSupabase({ getUser });
  const app = await startTestApp({ tasks: createFakeTasks(), supabase });
  return { app, supabase };
}

describe('a verified token', () => {
  test('returns the caller they were issued for, and only the four fields §4.D allows', async () => {
    const { app, supabase } = await appWith(verifyEverything);

    const response = await app.get('/protected/profile', { authorization: bearer('token-abc') });

    assert.equal(response.status, 200);
    assert.deepEqual(response.body, {
      id: 'user-for-token-abc',
      email: 'token-abc@verified.test',
      createdAt: fakeUser().created_at,
      emailConfirmedAt: fakeUser().email_confirmed_at,
    });
    assert.equal(supabase.inputFor('getUser'), 'token-abc');
    await app.close();
  });

  test('does not come back with the fields the provider put on the user object', async () => {
    // `fakeUser` carries an `encrypted_password`, a `phone`, `app_metadata` and a `role`, the same
    // fields a real GoTrue user object has. If publicUser ever spread instead of listing, this fails.
    const { app } = await appWith(verifyEverything);

    const response = await app.get('/protected/profile', { authorization: bearer('token-abc') });

    for (const secret of ['$2a$FAKE', '+15550001234', 'app_metadata', 'encrypted_password', 'identities']) {
      assert.equal(response.text.includes(secret), false, `profile leaked ${secret}`);
    }
    await app.close();
  });

  test('never repeats the token it was shown', async () => {
    // A fixed user here, not the token-derived one `verifyEverything` builds: that fake puts the token
    // into the id and email, so asserting "the body does not contain the token" against it would pass
    // only by accident and fail on purpose. The first version of this test did exactly that.
    const { app } = await appWith(() => ({ data: { user: fakeUser() }, error: null }));

    const response = await app.get('/protected/profile', { authorization: bearer(FAKE_ACCESS_TOKEN) });

    assert.equal(response.status, 200);
    assert.equal(response.text.includes(FAKE_ACCESS_TOKEN), false);
    await app.close();
  });

  test('two tokens in a row identify two different people, with no session carried between them', async () => {
    // The bug this is here to catch is the server-side one: a client that keeps a session, or a
    // handler that reads "the current user" from somewhere shared, answers the second caller with the
    // first caller's identity. Both requests go to the same app instance on purpose.
    const { app } = await appWith(verifyEverything);

    const first = await app.get('/protected/profile', { authorization: bearer('alice-token') });
    const second = await app.get('/protected/profile', { authorization: bearer('bob-token') });

    assert.equal(first.body.id, 'user-for-alice-token');
    assert.equal(second.body.id, 'user-for-bob-token');
    assert.notEqual(first.body.id, second.body.id);
    assert.notEqual(second.body.email, first.body.email);
    await app.close();
  });
});

describe('a token Supabase will not vouch for', () => {
  test('a 401 from the provider is a 401 here, with one generic message', async () => {
    const { app } = await appWith(() => ({
      data: { user: null },
      error: authError({ code: 'invalid_jwt', status: 401, message: 'JWT expired at 1700000000' }),
    }));

    const response = await app.get('/protected/profile', { authorization: bearer('expired-token') });

    assert.equal(response.status, 401);
    assert.deepEqual(response.body, { error: 'Invalid or expired token' });
    // "JWT expired at …" is true and useless to a caller who cannot mint a new one, and it tells an
    // attacker which check they failed. Both stay inside.
    assert.equal(response.text.includes('expired at'), false);
    await app.close();
  });

  test('a 403 from the provider is the same 401 answer, not a distinction we are not entitled to make', async () => {
    const { app } = await appWith(() => ({
      data: { user: null },
      error: authError({ code: 'not_allowed', status: 403, message: 'not allowed' }),
    }));

    const response = await app.get('/protected/profile', { authorization: bearer('forbidden-token') });

    assert.equal(response.status, 401);
    assert.deepEqual(response.body, { error: 'Invalid or expired token' });
    await app.close();
  });

  test('no error and no user is still a refusal, because §4.D says to check both', async () => {
    // The shape a route gets when the client library resolves quietly with nothing in it. A handler
    // that only looked at `error` would call this a successful profile.
    const { app } = await appWith(() => ({ data: { user: null }, error: null }));

    const response = await app.get('/protected/profile', { authorization: bearer('shapeless-token') });

    assert.equal(response.status, 401);
    assert.deepEqual(response.body, { error: 'Invalid or expired token' });
    await app.close();
  });

  test('a user this API cannot name is not a verified identity', async () => {
    // `{ id: undefined }` would otherwise answer 200 with `{ email: null, … }` — a profile of nobody.
    const { app } = await appWith(() => ({ data: { user: {} }, error: null }));

    const response = await app.get('/protected/profile', { authorization: bearer('anonymous-token') });

    assert.equal(response.status, 401);
    assert.deepEqual(response.body, { error: 'Invalid or expired token' });
    await app.close();
  });

  test('a provider that is unreachable is 502, and is never dressed up as a bad token', async () => {
    // The distinction matters to the person on the other end: 401 means "your credentials are no good",
    // 502 means "ours are down". Collapsing them sends every working client into a logout loop during
    // an outage and hides the outage from the metric that would have caught it.
    const { app } = await appWith(() => ({
      data: { user: null },
      error: Object.assign(new Error('fetch failed'), { name: 'AuthRetryableFetchError' }),
    }));

    const response = await app.get('/protected/profile', { authorization: bearer('any-token') });

    assert.equal(response.status, 502);
    assert.deepEqual(response.body, { error: 'authentication service is unreachable' });
    await app.close();
  });

  test('a client that throws is answered the same way as one that returns an error', async () => {
    const thrown = await appWith(() => {
      throw authError({ code: 'invalid_jwt', status: 401, message: 'Invalid JWT' });
    });
    const returned = await appWith(() => ({
      data: { user: null },
      error: authError({ code: 'invalid_jwt', status: 401, message: 'Invalid JWT' }),
    }));

    const a = await thrown.app.get('/protected/profile', { authorization: bearer('any-token') });
    const b = await returned.app.get('/protected/profile', { authorization: bearer('any-token') });

    assert.equal(a.status, 401);
    assert.equal(a.text, b.text);
    await thrown.app.close();
    await returned.app.close();
  });

  test('a session that no longer exists is the same generic 401, with nothing from the library leaking out', async () => {
    // The regression this holds in place: supabase-js turns GoTrue's 403 `session_not_found` into an
    // AuthSessionMissingError carrying status 400 and no code, and the login-shaped translator read
    // that as "caller sent a bad request" — answering `400 {"error":"Auth session missing!"}`. Wrong
    // status for §4.D, and the library's private wording in a public response body.
    const { app } = await appWith(() => ({ data: { user: null }, error: sessionMissingError() }));

    const response = await app.get('/protected/profile', { authorization: bearer('logged-out-token') });

    assert.equal(response.status, 401);
    assert.deepEqual(response.body, { error: 'Invalid or expired token' });
    assert.equal(response.text.includes('Auth session missing'), false);
    await app.close();
  });

  test('a provider that answers 429 or 5xx is not reported to the caller as a bad token', async () => {
    // describeVerificationError deliberately keeps only the statuses GoTrue uses to say "this token is
    // no good". Rate limiting and server faults are our problem, and filing them under 401 would tell
    // a well-behaved client to throw away a perfectly valid session and log in again.
    for (const status of [429, 500, 503]) {
      const { app } = await appWith(() => ({
        data: { user: null },
        error: authError({ code: 'over_rate_limit', status, message: 'slow down' }),
      }));

      const response = await app.get('/protected/profile', { authorization: bearer('any-token') });

      assert.equal(response.status, 502, `provider status ${status} is not the caller's fault`);
      assert.deepEqual(response.body, { error: 'authentication service could not verify this token' });
      await app.close();
    }
  });

  test('the token is never passed to the provider in a way that could be echoed back', async () => {
    // A regression guard on the wiring rather than on Supabase: whatever the header held is exactly
    // what getUser is asked about, once, and nothing else about the request travels with it.
    const { app, supabase } = await appWith((token) => ({ data: { user: fakeUser({ id: 'x-' + token }) }, error: null }));

    const response = await app.get('/protected/profile', {
      authorization: bearer('one-single-token'),
      'x-trace': 'should-be-ignored',
    });

    assert.equal(supabase.calls.length, 1);
    assert.equal(supabase.inputFor('getUser'), 'one-single-token');
    assert.equal(response.body.id, 'x-one-single-token');
    await app.close();
  });
});

describe('verification did not move anything else', () => {
  test('the public route stays public while the protected one is strict', async () => {
    const { app } = await appWith(() => ({ data: { user: null }, error: null }));

    const publicInfo = await app.get('/public/info');
    const profile = await app.get('/protected/profile');

    assert.equal(publicInfo.status, 200);
    assert.equal(profile.status, 401);
    await app.close();
  });

  test('signup and login still answer, and a token from login is what profile expects', async () => {
    // The full local loop, in one app: log in, take the access token out of the response, spend it on
    // the protected route. Same shape as the curl transcript in the README, without a network.
    const supabase = createFakeSupabase({ getUser: verifyEverything });
    const app = await startTestApp({ tasks: createFakeTasks(), supabase });

    const login = await app.post('/auth/login', { email: 'reader@example.com', password: 'correct-horse-battery' });
    const token = login.body.session.accessToken;

    const profile = await app.get('/protected/profile', { authorization: bearer(token) });

    assert.equal(login.status, 200);
    assert.equal(profile.status, 200, 'the token login handed out is the token profile accepts');
    assert.equal(profile.body.id, `user-for-${token}`);
    await app.close();
  });
});
