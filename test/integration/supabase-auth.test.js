// Integration checks against a real Supabase, which is what §7 asks for separately from the unit
// suite: mocks can prove that this API reacts correctly to a provider's answer, and only the provider
// can prove what its answers actually are.
//
// Deliberately outside `npm test` (the glob is `test/*.test.js`), because the unit suite must run with
// no credentials and no network. This one runs on request:
//
//   npx supabase start      # the stack in supabase/config.toml
//   npm run test:integration
//
// If the provider is unreachable the whole file fails with the command to run rather than reporting a
// green suite, because "0 failures" from a file that tested nothing would be the worst kind of pass.
//
// What it does touch: it creates throwaway accounts (`@flyrank.test`, random passwords) in the local
// dev database and signs them out again afterwards. They accumulate — `npx supabase stop --no-backup`
// clears them with the rest of the dev data. No real credentials and no production project belong in
// here.
//
// Nothing in this file prints a token, a password or the JWT secret. Where a value matters, its length
// or a prefix of a user id is printed instead.
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const { after, before, describe, test } = require('node:test');

const { loadConfig } = require('../../src/config');
const { createSupabaseClient, signOutAs } = require('../../src/supabase');
const { createFakeTasks } = require('../helpers/fake-tasks');
const { bearer, closeAllTestServers, startTestApp } = require('../helpers/server');

const AUTH_CONTAINER = process.env.SUPABASE_AUTH_CONTAINER || 'supabase_auth_w2-a4-supabase-auth';

let config;
let app;
let logLines;
const created = []; // { email, accessToken } for cleanup

before(async () => {
  config = loadConfig();

  // Ask before assuming: a stack that is configured but not running would otherwise produce a page of
  // ECONNREFUSED that looks like a bug in this API.
  const health = await fetch(`${config.supabaseUrl}/auth/v1/health`).catch(() => null);
  if (!health || !health.ok) {
    throw new Error(
      `Supabase at ${config.supabaseUrl} is not answering /auth/v1/health. ` +
        'Start the local stack with `npx supabase start` (or point SUPABASE_URL/SUPABASE_KEY at a ' +
        'project you are willing to create test accounts in) and run this file again.',
    );
  }

  logLines = [];
  const supabase = createSupabaseClient(config);
  const signOut = ({ accessToken }) =>
    signOutAs({ supabaseUrl: config.supabaseUrl, supabaseKey: config.supabaseKey, accessToken });

  app = await startTestApp({
    tasks: createFakeTasks(),
    supabase,
    signOut,
    log: (line) => logLines.push(line),
  });
});

after(async () => {
  if (!config) return; // `before` never got as far as loading it, so there is nothing to sign out of.
  // Best effort, and quiet about it: a failed cleanup of a throwaway account is not a test failure.
  await Promise.all(
    created
      .filter((account) => account.accessToken)
      .map((account) =>
        signOutAs({
          supabaseUrl: config.supabaseUrl,
          supabaseKey: config.supabaseKey,
          accessToken: account.accessToken,
        }).catch(() => {}),
      ),
  );
  if (app) await app.close();
  await closeAllTestServers();
});

async function makeAccount(label) {
  const email = `integration-${label}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}@flyrank.test`;
  const password = `integration-${label}-${crypto.randomUUID()}`;

  const signup = await app.post('/auth/signup', { email, password });
  assert.equal(signup.status, 201, `signup should succeed for ${label}: ${JSON.stringify(signup.body)}`);

  const login = await app.post('/auth/login', { email, password });
  assert.equal(login.status, 200, `login should succeed for ${label}: ${JSON.stringify(login.body)}`);

  const account = {
    label,
    email,
    password,
    id: signup.body.user.id,
    accessToken: login.body.session.accessToken,
    refreshToken: login.body.session.refreshToken,
  };
  created.push(account);
  return account;
}

describe('against a real Supabase', () => {
  test('signup and login hand back a session, and both agree about who the user is', async () => {
    const account = await makeAccount('identity');

    assert.ok(account.accessToken.length > 40, 'a real access token is a JWT, not a short string');
    assert.ok(account.refreshToken.length > 0, 'and a refresh token comes back too');
    // Signup answered with one user object, login with another. If the route ever mixed them up, or
    // normalisation made two accounts of one email, this is where it shows.
    assert.equal(typeof account.id, 'string', 'signup gave a user id');
    assert.ok(account.id.length > 0);

    const profile = await app.get('/protected/profile', { authorization: bearer(account.accessToken) });
    assert.equal(profile.body.id, account.id, 'the token login issued names the user signup created');
  });

  test('a real token returns exactly the four documented profile fields, from the live user object', async () => {
    const account = await makeAccount('profile');

    const profile = await app.get('/protected/profile', { authorization: bearer(account.accessToken) });

    assert.equal(profile.status, 200);
    // The unit tests use a fake user object. This is the real one, which has more fields on it than my
    // fake ever did (`identities`, `confirmed_at`, `last_sign_in_at`, …), so this is where "only the
    // safe four" is actually worth checking.
    assert.deepEqual(Object.keys(profile.body).sort(), ['createdAt', 'email', 'emailConfirmedAt', 'id']);
    assert.equal(profile.body.email, account.email);
    assert.equal(profile.body.id, account.id);
    assert.equal(/\$2a\$|encrypted_password|app_metadata|phone/.test(profile.text), false, 'no credential material in the body');
  });

  test('the dashboard and the profile name the same real person', async () => {
    const account = await makeAccount('dashboard');

    const profile = await app.get('/protected/profile', { authorization: bearer(account.accessToken) });
    const dashboard = await app.get('/protected/dashboard', { authorization: bearer(account.accessToken) });

    assert.equal(dashboard.status, 200);
    assert.deepEqual(Object.keys(dashboard.body).sort(), ['message', 'userId']);
    assert.equal(dashboard.body.userId, profile.body.id);
  });

  test('two live sessions identify two different people, with nothing shared between them', async () => {
    // The server-state bug this exists to catch: a client that holds "the current session" answers the
    // second caller with the first caller's identity. Against a fake this is a wiring check; against
    // the real provider it is a claim about supabase-js being used correctly on a stateless server.
    const one = await makeAccount('pair-a');
    const two = await makeAccount('pair-b');

    const firstProfile = await app.get('/protected/profile', { authorization: bearer(one.accessToken) });
    const secondProfile = await app.get('/protected/profile', { authorization: bearer(two.accessToken) });

    assert.equal(firstProfile.body.email, one.email);
    assert.equal(secondProfile.body.email, two.email);
    assert.notEqual(firstProfile.body.id, secondProfile.body.id);
  });

  test('logout answers 204, and on this provider the same access token then stops verifying', async () => {
    const account = await makeAccount('logout');

    const before = await app.get('/protected/profile', { authorization: bearer(account.accessToken) });
    assert.equal(before.status, 200);

    const logout = await app.post('/auth/logout', undefined, { authorization: bearer(account.accessToken) });
    assert.equal(logout.status, 204);
    assert.equal(logout.text, '', '204 means no body');

    const afterProfile = await app.get('/protected/profile', { authorization: bearer(account.accessToken) });
    // Asserted as behaviour of THIS stack, measured rather than promised: GoTrue revokes the session
    // and stops vouching for the token, so the route answers the §4.D 401. If a future provider stops
    // doing that, this test failing is the correct outcome — the README's logout section would then be
    // wrong and has to be re-measured, not quietly edited.
    assert.equal(
      afterProfile.status,
      401,
      'a logged-out access token still verifies on this provider; update the README rather than this line if it changes',
    );
    assert.deepEqual(afterProfile.body, { error: 'Invalid or expired token' });
  });

  test('the refresh token that logout ended is refused by the provider too', async () => {
    const account = await makeAccount('refresh');

    const logout = await app.post('/auth/logout', undefined, { authorization: bearer(account.accessToken) });
    assert.equal(logout.status, 204);

    const refreshed = await fetch(`${config.supabaseUrl}/auth/v1/token?grant_type=refresh_token`, {
      method: 'POST',
      headers: { apikey: config.supabaseKey, 'content-type': 'application/json' },
      body: JSON.stringify({ refresh_token: account.refreshToken }),
    });
    // Only read the body when it failed: a successful refresh returns a new session, and printing that
    // would put a live token in the test output.
    assert.equal(refreshed.ok, false, 'a revoked refresh token must not mint a new session');
    const detail = await refreshed.text();
    assert.match(detail, /refresh_token/, 'and the provider says why in terms of the refresh token');
  });

  test('the same person can sign in again after logging out, and the new token works', async () => {
    const account = await makeAccount('reentry');
    const email = account.email;

    const logout = await app.post('/auth/logout', undefined, { authorization: bearer(account.accessToken) });
    assert.equal(logout.status, 204);

    const again = await app.post('/auth/login', { email, password: account.password });
    assert.equal(again.status, 200, 'logout is not account deletion');

    const fresh = await app.get('/protected/profile', { authorization: bearer(again.body.session.accessToken) });
    assert.equal(fresh.status, 200);
    assert.equal(fresh.body.email, email);
  });

  test('a token minted from the project JWT secret cannot be revoked, and can sign the user out of real sessions', async (t) => {
    // The most important test in this file, and the one that only a real provider can tell us about.
    //
    // This stack issues ES256 tokens, but GoTrue also still verifies HS256 tokens signed with the
    // legacy symmetric secret (both GOTRUE_JWT_KEYS and GOTRUE_JWT_SECRET are set on the container).
    // Such a minted token carries no `session_id`, so there is nothing for a logout to revoke — and
    // because GoTrue resolves the user from `sub`, using one to call /auth/logout ends that user's
    // genuine sessions. In other words: whoever holds that secret can read any account and log any
    // account out. This is inherited from the provider configuration, not from this route, and it is
    // recorded here so the README states it instead of implying that verification proves more.
    let secret;
    try {
      secret = execFileSync('docker', ['exec', AUTH_CONTAINER, 'printenv', 'GOTRUE_JWT_SECRET'], { encoding: 'utf8' }).trim();
    } catch {
      secret = '';
    }
    if (!secret) {
      // Reported as skipped rather than passed: "0 failures" would otherwise hide the fact that the
      // most interesting claim in this file was never checked. Name the container with
      // SUPABASE_AUTH_CONTAINER if this stack runs under a different one.
      t.skip(`no GOTRUE_JWT_SECRET readable from container ${AUTH_CONTAINER}`);
      return;
    }

    const account = await makeAccount('minted');
    const b64 = (value) => Buffer.from(value).toString('base64url');
    const claims = JSON.parse(Buffer.from(account.accessToken.split('.')[1], 'base64url').toString());
    const now = Math.floor(Date.now() / 1000);
    const mint = (payload) => {
      const header = b64(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
      const body = b64(JSON.stringify(payload));
      return `${header}.${body}.${crypto.createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url')}`;
    };
    const stripped = mint({ aud: 'authenticated', exp: now + 3600, iat: now - 60, iss: claims.iss, role: 'authenticated', sub: claims.sub });

    const mintedProfile = await app.get('/protected/profile', { authorization: bearer(stripped) });
    assert.equal(mintedProfile.status, 200, 'a correctly signed token with only the core claims verifies');
    assert.equal(mintedProfile.body.id, account.id, 'and it names whoever `sub` says, which is the whole risk');

    // A separate genuine session for the same user, to see whether the forged call damages it.
    const secondLogin = await app.post('/auth/login', { email: account.email, password: account.password });
    assert.equal(secondLogin.status, 200);
    const genuineToken = secondLogin.body.session.accessToken;
    created.push({ email: account.email, accessToken: genuineToken });

    const forgedLogout = await app.post('/auth/logout', undefined, { authorization: bearer(stripped) });
    assert.equal(forgedLogout.status, 204, 'the provider accepted a sign-out requested by a forged token');

    const genuineAfter = await app.get('/protected/profile', { authorization: bearer(genuineToken) });
    assert.equal(genuineAfter.status, 401, 'and the user\'s real session did not survive it');

    const mintedAfter = await app.get('/protected/profile', { authorization: bearer(stripped) });
    assert.equal(mintedAfter.status, 200, 'while the forged token itself is unrevocable');
  });

  test('no token, no password and no header name appears in anything the server wrote out', async () => {
    // The point of an injectable log sink: this app's request log is the one place a token could end up
    // by accident, and the check runs against the lines a real provider exchange actually produced.
    const joined = logLines.join('\n');

    assert.equal(joined.includes('Bearer'), false, 'no Authorization values');
    assert.equal(/authorization/i.test(joined), false, 'not even the header name');
    assert.equal(joined.includes('eyJ'), false, 'no JWT material');
    for (const account of created) {
      if (account.accessToken) assert.equal(joined.includes(account.accessToken), false, 'account token absent');
      if (account.refreshToken) assert.equal(joined.includes(account.refreshToken), false, 'refresh token absent');
      if (account.password) assert.equal(joined.includes(account.password), false, 'password absent');
    }
    assert.ok(logLines.length > 5, 'and there were requests to check, not an empty log');
  });
});
