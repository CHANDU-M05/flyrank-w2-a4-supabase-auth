// A stand-in for the `@supabase/supabase-js` client, so auth routes can be tested over real HTTP
// without credentials and without a network call (§7 requires exactly that for unit tests).
//
// It is shaped like the real thing in the ways the routes actually read: `{ data, error }` returns,
// an `AuthApiError`-shaped error carrying `name` / `status` / `code`, and a session whose token fields
// are named the way GoTrue names them. It is not a reimplementation of GoTrue — there is no password
// check, no user store, no email confirmation. A fake that grew those would be the thing under test
// instead of the route, and the claims that need a real identity provider are checked against the
// running local Supabase — the `curl` transcript in the README and the integration tests that use the
// same stack.
//
// The default token and user values are obviously fake on purpose: a test that accidentally printed
// one could not be mistaken for a leaked credential, and the log-leak assertions in
// test/unit.auth.test.js search these exact strings.
const FAKE_USER_ID = '00000000-0000-4000-8000-000000000001';
const FAKE_ACCESS_TOKEN = 'fake-access-token.not-a-jwt.AAAAAAAAAAAA';
const FAKE_REFRESH_TOKEN = 'fake-refresh-token.not-a-jwt.BBBBBBBBBBBB';

function fakeUser(overrides = {}) {
  return {
    id: FAKE_USER_ID,
    aud: 'authenticated',
    role: 'authenticated',
    email: 'reader@example.com',
    email_confirmed_at: '2026-10-26T09:00:00.000000+00:00',
    created_at: '2026-10-26T09:00:00.000000+00:00',
    updated_at: '2026-10-26T09:00:00.000000+00:00',
    // Fields a route must never return. They live on the real user object too, which is why
    // publicUser() picks named fields instead of spreading.
    encrypted_password: '$2a$FAKE$notahash',
    app_metadata: { provider: 'email' },
    user_metadata: { last_sign_in_email: 'reader@example.com' },
    phone: '+15550001234',
    ...overrides,
  };
}

function fakeSession(overrides = {}) {
  return {
    access_token: FAKE_ACCESS_TOKEN,
    refresh_token: FAKE_REFRESH_TOKEN,
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: 1793000000,
    user: fakeUser(),
    ...overrides,
  };
}

// Builds an error with the same surface supabase-js returns. `code` is the value GoTrue puts in
// `error_code`; the mapping in routes/auth.js keys off it, so a test that wants a specific status has
// to supply the code a real server would send — inventing a message alone proves nothing.
function authError({ code, message, status }) {
  const error = new Error(message ?? `auth error ${code}`);
  error.name = 'AuthApiError';
  error.__isAuthError = true;
  error.status = status;
  error.code = code;
  return error;
}

// Each behaviour may be a value (`{ data, error }`) or a function of the input, so a test can say
// "sign-up fails with this error" or "sign-up echoes the email it was handed" without ceremony. What
// this returns is always a function: a fallback that happens to be a function must be called, not
// handed back as if it were the response.
function responder(behaviour, fallback) {
  if (typeof behaviour === 'function') return behaviour;
  if (behaviour !== undefined && behaviour !== null) return () => behaviour;
  return fallback;
}

function createFakeSupabase({ signUp, signInWithPassword, getUser, throwInstead } = {}) {
  const calls = [];

  const record = (method, behaviour, fallback) => async (input) => {
    calls.push({ method, input });
    // `throwInstead` models the path supabase-js does not convert into a returned error: a client that
    // blows up. Routes are supposed to survive both shapes identically.
    if (throwInstead) throw typeof throwInstead === 'function' ? throwInstead(input) : throwInstead;
    return responder(behaviour, fallback)(input);
  };

  const defaultSignUp = (input) => ({
    data: { user: fakeUser({ email: input.email }), session: fakeSession({ user: fakeUser({ email: input.email }) }) },
    error: null,
  });

  const defaultSignIn = () => ({
    data: { user: fakeUser(), session: fakeSession() },
    error: null,
  });

  return {
    calls,
    methods: () => calls.map((call) => call.method),
    inputFor: (method) => calls.find((call) => call.method === method)?.input,
    auth: {
      signUp: record('signUp', signUp, defaultSignUp),
      signInWithPassword: record('signInWithPassword', signInWithPassword, defaultSignIn),
      // Stage 3 and 4 use this; it is here so the fake is one object rather than two generations of
      // helpers. A missing `getUser` returns "no user, no error", which is the shape no real
      // verification produces and is therefore a good way to catch a route that trusts it.
      getUser: record('getUser', getUser, () => ({ data: { user: null }, error: null })),
    },
  };
}

module.exports = {
  FAKE_ACCESS_TOKEN,
  FAKE_REFRESH_TOKEN,
  FAKE_USER_ID,
  authError,
  createFakeSupabase,
  fakeSession,
  fakeUser,
};
