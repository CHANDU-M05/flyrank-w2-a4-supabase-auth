// Auth routes, tested without credentials and without a network — which is what §7 asks for: unit
// tests mock Supabase, and the claims that only a real identity provider can answer are checked
// against the local stack separately.
//
// Three things these tests are trying to pin down:
//   1. input never reaches Supabase unless it is well-formed,
//   2. Supabase's failures become this API's statuses and envelope, never its stack traces,
//   3. passwords and tokens move through the app without ever landing in a response the client did
//      not ask for, or in a log line.
const assert = require('node:assert/strict');
const { after, describe, test } = require('node:test');

const { cleanEmail, cleanPassword } = require('../src/routes/auth');
const { HttpError } = require('../src/errors');
const { describeAuthError, publicSession, publicUser } = require('../src/supabase');
const {
  FAKE_ACCESS_TOKEN,
  FAKE_REFRESH_TOKEN,
  authError,
  createFakeSupabase,
  fakeSession,
  fakeUser,
} = require('./helpers/fake-supabase');
const { createFakeTasks } = require('./helpers/fake-tasks');
const { closeAllTestServers, startTestApp } = require('./helpers/server');

const PASSWORD = 'correct-horse-battery';

// Most tests in this file open their own app on its own port and close it. This is the net underneath:
// if an assertion fails before the close, the server would otherwise keep the process alive and the
// suite would hang instead of reporting the failure.
after(closeAllTestServers);

describe('what counts as an email and a password', () => {
  test('a missing email is a 400 that names it', () => {
    assert.throws(() => cleanEmail(undefined), (error) => {
      assert.equal(error.status, 400);
      assert.equal(error.message, 'email is required');
      return true;
    });
    assert.throws(() => cleanEmail(null), /email is required/);
  });

  test('empty, whitespace and non-strings are all rejected, none of them silently coerced', () => {
    for (const value of ['', '   ', 42, true, {}, ['a@b.co']]) {
      assert.throws(() => cleanEmail(value), /email must be a non-empty string/, `cleanEmail(${JSON.stringify(value)})`);
    }
  });

  test('an address-shaped string is accepted, a not-address-shaped one is not', () => {
    for (const value of ['a@b.co', 'first.last+tag@sub.example.com', '  admin@flyrank.dev  ']) {
      assert.doesNotThrow(() => cleanEmail(value), `cleanEmail(${value})`);
    }
    for (const value of ['hello', 'a@b', 'a b@example.com', '@example.com', 'admin@']) {
      assert.throws(() => cleanEmail(value), /email must be a valid email address/, `cleanEmail(${value})`);
    }
  });

  test('the stored address is trimmed and lowercased, so casing cannot fork an account', () => {
    assert.equal(cleanEmail('  Admin@FlyRank.DEV  '), 'admin@flyrank.dev');
  });

  test('a password is required and never trimmed, because spaces can be part of a secret', () => {
    assert.throws(() => cleanPassword(undefined), { message: 'password is required', status: 400 });
    assert.throws(() => cleanPassword(''), { message: 'password must be a non-empty string', status: 400 });
    assert.throws(() => cleanPassword(123456), /password must be a non-empty string/);
    assert.equal(cleanPassword('  spaces around me  '), '  spaces around me  ');
    // Strength is Supabase's policy, not something this API duplicates — see the weak_password test.
    assert.equal(cleanPassword('abc'), 'abc');
  });
});

describe('Supabase failures become this API answers', () => {
  test('rejected credentials are 401 with the exact body §4.B asks for', () => {
    const error = describeAuthError(authError({ code: 'invalid_credentials', status: 400, message: 'Invalid login credentials' }));

    assert.ok(error instanceof HttpError);
    assert.equal(error.status, 401);
    assert.equal(error.message, 'Invalid login credentials');
  });

  test('a duplicate account says so, with the enumeration cost written up in the code', () => {
    const error = describeAuthError(authError({ code: 'user_already_exists', status: 422, message: 'User already registered' }));

    assert.equal(error.status, 409);
    assert.equal(error.message, 'an account with that email already exists');
  });

  test("a provider's own advice about input is passed through, at our 400", () => {
    const error = describeAuthError(
      authError({ code: 'weak_password', status: 422, message: 'Password should be at least 6 characters.' }),
    );

    assert.equal(error.status, 400);
    assert.equal(error.message, 'Password should be at least 6 characters.');
  });

  test('a token problem is answered generically, never with what was wrong about the token', () => {
    for (const status of [401, 403]) {
      const error = describeAuthError(authError({ code: 'not_in_map', status, message: 'JWT expired' }));

      assert.equal(error.status, 401);
      assert.equal(error.message, 'Invalid or expired token');
    }
  });

  test('a failure with no status is auth being down, and the library wording stays inside', () => {
    const error = describeAuthError(new Error('fetch failed: connect ECONNREFUSED 127.0.0.1:54321'));

    assert.equal(error.status, 502);
    assert.equal(error.message, 'authentication service is unreachable');
    assert.doesNotMatch(error.message, /ECONNREFUSED|54321|fetch failed/);
  });

  test('a provider message long enough to be a payload is cut, not shipped', () => {
    const error = describeAuthError(authError({ code: 'validation_failed', status: 400, message: 'x'.repeat(5000) }));

    assert.equal(error.message.length, 201);
    assert.match(error.message, /…$/);
  });

  test('a publicUser is four fields, whatever else the provider put on the object', () => {
    const user = publicUser(fakeUser());

    assert.deepEqual(Object.keys(user).sort(), ['createdAt', 'email', 'emailConfirmedAt', 'id']);
    const json = JSON.stringify(user);
    for (const secret of ['$2a$FAKE', '+15550001234', 'app_metadata', 'authenticated']) {
      assert.equal(json.includes(secret), false, `publicUser leaked ${secret}`);
    }
    assert.equal(publicUser(null), null);
  });

  test('a publicSession carries the tokens a client needs and nothing else', () => {
    assert.deepEqual(publicSession(fakeSession()), {
      accessToken: FAKE_ACCESS_TOKEN,
      refreshToken: FAKE_REFRESH_TOKEN,
      tokenType: 'bearer',
      expiresIn: 3600,
    });
    assert.equal(publicSession(null), null);
  });
});

describe('POST /auth/signup', () => {
  test('a good signup is 201 with a user and a session, and the client saw the normalised email', async () => {
    const supabase = createFakeSupabase();
    const app = await startTestApp({ tasks: createFakeTasks(), supabase });

    const response = await app.post('/auth/signup', { email: '  Reader@Example.COM ', password: PASSWORD });

    assert.equal(response.status, 201);
    assert.deepEqual(Object.keys(response.body).sort(), ['session', 'user']);
    assert.equal(response.body.user.email, 'reader@example.com');
    assert.deepEqual(supabase.inputFor('signUp'), { email: 'reader@example.com', password: PASSWORD });
    await app.close();
  });

  test('the password is passed through exactly as typed, and is not in the response', async () => {
    const supabase = createFakeSupabase();
    const app = await startTestApp({ tasks: createFakeTasks(), supabase });

    const response = await app.post('/auth/signup', { email: 'reader@example.com', password: ' s3cr3t ' });

    assert.equal(supabase.inputFor('signUp').password, ' s3cr3t ');
    assert.equal(response.text.includes('s3cr3t'), false);
    await app.close();
  });

  test('malformed input is refused before Supabase is asked anything', async () => {
    const supabase = createFakeSupabase();
    const app = await startTestApp({ tasks: createFakeTasks(), supabase });

    const cases = [
      [{ password: PASSWORD }, 'email is required'],
      [{ email: 'reader@example.com' }, 'password is required'],
      [{ email: 'hello', password: PASSWORD }, 'email must be a valid email address'],
      [{ email: 'reader@example.com', password: '' }, 'password must be a non-empty string'],
      [{ email: ['reader@example.com'], password: PASSWORD }, 'email must be a non-empty string'],
    ];

    for (const [body, message] of cases) {
      const response = await app.post('/auth/signup', body);

      assert.equal(response.status, 400, `body ${JSON.stringify(body)}`);
      assert.deepEqual(response.body, { error: message });
    }
    assert.equal(supabase.calls.length, 0, 'validation must not reach the provider');
    await app.close();
  });

  test('a body that is not an object is a 400, not a crash', async () => {
    const app = await startTestApp({ tasks: createFakeTasks(), supabase: createFakeSupabase() });

    const response = await app.post('/auth/signup', ['reader@example.com', PASSWORD]);

    assert.equal(response.status, 400);
    assert.deepEqual(response.body, { error: 'request body must be a JSON object' });
    await app.close();
  });

  test('a project that still needs email confirmation signs up with no session', async () => {
    const supabase = createFakeSupabase({
      signUp: (input) => ({ data: { user: fakeUser({ email: input.email }), session: null }, error: null }),
    });
    const app = await startTestApp({ tasks: createFakeTasks(), supabase });

    const response = await app.post('/auth/signup', { email: 'reader@example.com', password: PASSWORD });

    assert.equal(response.status, 201);
    assert.equal(response.body.session, null);
    assert.equal(response.body.user.id, fakeUser().id);
    await app.close();
  });

  test('a 2xx that carries no user is reported as the provider failing, not as a signup', async () => {
    const supabase = createFakeSupabase({ signUp: { data: { user: null, session: null }, error: null } });
    const app = await startTestApp({ tasks: createFakeTasks(), supabase });

    const response = await app.post('/auth/signup', { email: 'reader@example.com', password: PASSWORD });

    assert.equal(response.status, 502);
    assert.deepEqual(response.body, { error: 'authentication service returned no user' });
    await app.close();
  });

  test('a duplicate email arrives as 409 in the shared envelope', async () => {
    const supabase = createFakeSupabase({
      signUp: {
        data: null,
        error: authError({ code: 'user_already_exists', status: 422, message: 'User already registered' }),
      },
    });
    const app = await startTestApp({ tasks: createFakeTasks(), supabase });

    const response = await app.post('/auth/signup', { email: 'reader@example.com', password: PASSWORD });

    assert.equal(response.status, 409);
    assert.deepEqual(response.body, { error: 'an account with that email already exists' });
    await app.close();
  });

  test('with no Supabase configured the route says 503, not 404', async () => {
    const app = await startTestApp({ tasks: createFakeTasks(), supabase: null });

    const response = await app.post('/auth/signup', { email: 'reader@example.com', password: PASSWORD });

    assert.equal(response.status, 503);
    assert.deepEqual(response.body, { error: 'authentication is not configured' });
    await app.close();
  });
});

describe('POST /auth/login', () => {
  test('a good login returns both tokens and the same four user fields', async () => {
    const app = await startTestApp({ tasks: createFakeTasks(), supabase: createFakeSupabase() });

    const response = await app.post('/auth/login', { email: 'reader@example.com', password: PASSWORD });

    assert.equal(response.status, 200);
    assert.deepEqual(response.body.session, {
      accessToken: FAKE_ACCESS_TOKEN,
      refreshToken: FAKE_REFRESH_TOKEN,
      tokenType: 'bearer',
      expiresIn: 3600,
    });
    assert.deepEqual(Object.keys(response.body.user).sort(), ['createdAt', 'email', 'emailConfirmedAt', 'id']);
    await app.close();
  });

  test('a wrong password and an unknown account answer identically', async () => {
    const rejected = {
      data: null,
      error: authError({ code: 'invalid_credentials', status: 400, message: 'Invalid login credentials' }),
    };
    const app = await startTestApp({ tasks: createFakeTasks(), supabase: createFakeSupabase({ signInWithPassword: rejected }) });

    const wrongPassword = await app.post('/auth/login', { email: 'reader@example.com', password: 'not-the-password' });
    const unknownAccount = await app.post('/auth/login', { email: 'nobody@example.com', password: PASSWORD });

    assert.equal(wrongPassword.status, 401);
    assert.deepEqual(wrongPassword.body, { error: 'Invalid login credentials' });
    assert.equal(wrongPassword.text, unknownAccount.text, 'login must not reveal which accounts exist');
    await app.close();
  });

  test('missing fields are refused before the provider is contacted', async () => {
    const supabase = createFakeSupabase();
    const app = await startTestApp({ tasks: createFakeTasks(), supabase });

    const noBody = await app.post('/auth/login', {});
    const noEmail = await app.post('/auth/login', { password: PASSWORD });
    const noPassword = await app.post('/auth/login', { email: 'reader@example.com' });

    assert.deepEqual(noBody.body, { error: 'email is required' });
    assert.deepEqual(noEmail.body, { error: 'email is required' });
    assert.deepEqual(noPassword.body, { error: 'password is required' });
    for (const response of [noBody, noEmail, noPassword]) {
      assert.equal(response.status, 400);
    }
    assert.equal(supabase.calls.length, 0);
    await app.close();
  });

  test('a client that throws is answered the same as a client that returns an error', async () => {
    const thrown = await startTestApp({
      tasks: createFakeTasks(),
      supabase: createFakeSupabase({ throwInstead: new Error('fetch failed') }),
    });
    const returned = await startTestApp({
      tasks: createFakeTasks(),
      supabase: createFakeSupabase({
        signInWithPassword: { data: null, error: Object.assign(new Error('fetch failed'), { name: 'AuthRetryableFetchError' }) },
      }),
    });

    const a = await thrown.post('/auth/login', { email: 'reader@example.com', password: PASSWORD });
    const b = await returned.post('/auth/login', { email: 'reader@example.com', password: PASSWORD });

    assert.equal(a.status, 502);
    assert.equal(a.text, b.text);
    assert.equal(a.text.includes('fetch failed'), false);
    await thrown.close();
    await returned.close();
  });

  test('a login that comes back without a session is not passed on as success', async () => {
    const supabase = createFakeSupabase({
      signInWithPassword: { data: { user: fakeUser(), session: null }, error: null },
    });
    const app = await startTestApp({ tasks: createFakeTasks(), supabase });

    const response = await app.post('/auth/login', { email: 'reader@example.com', password: PASSWORD });

    assert.equal(response.status, 502);
    assert.deepEqual(response.body, { error: 'authentication service returned no session' });
    await app.close();
  });
});

describe('what the auth routes write down', () => {
  test('a signup and a login leave no credential in the request log', async () => {
    const lines = [];
    const app = await startTestApp({
      tasks: createFakeTasks(),
      supabase: createFakeSupabase(),
      log: (line) => lines.push(line),
    });

    await app.post('/auth/signup', { email: 'reader@example.com', password: PASSWORD });
    const login = await app.post('/auth/login', { email: 'reader@example.com', password: PASSWORD });

    assert.equal(login.status, 200, 'the requests must actually have happened');
    assert.ok(lines.length >= 2, 'and the logger must actually have been called');
    const log = lines.join('\n');
    for (const secret of [PASSWORD, FAKE_ACCESS_TOKEN, FAKE_REFRESH_TOKEN, 'Bearer', '$2a$FAKE']) {
      assert.equal(log.includes(secret), false, `the log line contained ${secret}`);
    }
    // The logger is still useful: method, path and status survive.
    assert.match(log, /POST \/auth\/login 200/);
    await app.close();
  });

  test('an unmatched path under /auth is a 404 in the envelope, not Express HTML', async () => {
    const app = await startTestApp({ tasks: createFakeTasks(), supabase: createFakeSupabase() });

    const response = await app.post('/auth/nonsense');

    assert.equal(response.status, 404);
    assert.deepEqual(response.body, { error: 'POST /auth/nonsense not found' });
    await app.close();
  });

  test('adding auth did not disturb the task contract it was mounted next to', async () => {
    const app = await startTestApp({ tasks: createFakeTasks(), supabase: createFakeSupabase() });

    const tasks = await app.get('/tasks');
    const created = await app.post('/tasks', { title: 'still works' });

    assert.equal(tasks.status, 200);
    assert.equal(tasks.body.length, 3);
    assert.equal(created.status, 201);
    assert.deepEqual(created.body, { id: 4, title: 'still works', done: false });

    const root = await app.get('/');
    assert.ok(root.body.endpoints.includes('POST /auth/signup'));
    assert.equal(root.body.auth, 'supabase');
    await app.close();
  });
});
