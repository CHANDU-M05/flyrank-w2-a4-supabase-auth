// One reusable Supabase client, the one auth operation that cannot be done with a shared client, and
// the translation layer between what Supabase reports and what this API says.
//
// Why the client is configured the way it is:
//
//   persistSession: false      — this is a server. There is no browser storage to keep a session
//                                in, and a process-wide session would be a bug: whichever user
//                                happened to log in last would become "the session" for every
//                                later request.
//   autoRefreshToken: false    — the server does not hold refresh tokens. Handing out a new access
//                                token is the client's job; it sends the bearer it has, and gets a
//                                401 when that token is no longer good.
//   detectSessionInUrl: false  — a browser-only feature; meaningless here and slow if left on.
//
// The client is created once and shared, because sharing it is safe: it holds no user state. Every
// call that needs to know *who* is asking passes the bearer token explicitly.
const { createClient } = require('@supabase/supabase-js');

const { HttpError } = require('./errors');

function createSupabaseClient({ supabaseUrl, supabaseKey }) {
  return createClient(supabaseUrl, supabaseKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}

// Signing out is the one operation where a shared client would be wrong, so it gets a request-scoped
// call instead: the token in the Authorization header names the session to end, and nothing else.
//
// `@supabase/supabase-js`'s own `signOut()` signs out whatever session the client instance happens
// to be holding — on a stateless server that is no session at all. The equivalent of "log this
// caller out" is GoTrue's POST /auth/v1/logout with the caller's bearer token, which is what this
// does. `scope` decides how wide the cut is:
//
//   global  revoke every session for the user (every refresh token they hold)
//   local   revoke only this session
//   others  revoke every session except this one
//
// What "logged out" actually means here, measured against the local stack rather than assumed:
//
//   the bearer you were holding stops working. A global sign-out revokes the session its `sub` names,
//   and from then on GoTrue answers `session_not_found` for that access token — so /protected/*
//   returns 401. Measured in test/integration/supabase-auth.test.js.
//
// That is not the same as the JWT becoming meaningless. Nothing was re-signed and nothing was
// blacklisted by this server (it holds no state): the token is still cryptographically valid until
// `jwt_expiry` passes, and whether it is *accepted* depends on the provider still recognising the
// session behind it. Two consequences worth knowing, both measured:
//
//   1. a token with no session behind it cannot be revoked this way. An access token minted from the
//      project's symmetric JWT secret carries no `session_id`, verifies fine, and survives every
//      logout you can ask for — see the README's security notes.
//   2. `scope = global` is wider than one device: it ends every session for that user, so signing out
//      on a laptop also signs out the phone. `local` would end only this session, and `others` only
//      the others. Global is what supabase-js defaults to and what a user typing "log out" means.
//
// So the sentence to avoid is "logout invalidates all issued tokens", which is a claim about this
// server's power that it does not have. What is true: logout ends the provider's sessions for that
// user, and tokens that were backed by one stop verifying.
async function signOutAs({ supabaseUrl, supabaseKey, accessToken, scope = 'global' }) {
  const response = await fetch(`${supabaseUrl}/auth/v1/logout?scope=${encodeURIComponent(scope)}`, {
    method: 'POST',
    headers: {
      apikey: supabaseKey,
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    // GoTrue answers 401 when the bearer is not a live session. Report the status, never the token.
    const error = new Error(`sign-out failed: ${response.status}`);
    error.name = 'SupabaseError';
    error.status = response.status;
    throw error;
  }

  return true;
}

// ---------------------------------------------------------------------------
// Describing what the provider said.
//
// These live here rather than in a route file because more than one route needs them: signup and
// login translate Supabase's failures into HTTP, and every route behind the auth middleware verifies
// a token through the same rules. Importing them out of `routes/auth.js` would make one route the
// owner of another route's vocabulary.
// ---------------------------------------------------------------------------

// The one answer every verification failure shares, §4.D. A caller cannot fix an expired token, and
// an attacker should not learn which of the checks they failed — signature, expiry, or a session that
// logout ended. Named here so the route and the middleware cannot drift into two phrasings.
const INVALID_TOKEN = 'Invalid or expired token';

// Supabase's AuthApiError carries a stable `code`, the `status` GoTrue answered with and a human
// `message` — all three observed against this stack, so this maps on `code` and treats `message` as
// display text rather than something to pattern-match.
//
// Deliberately absent: `over_email_send_rate_limit`, `too_many_requests` and the rest of GoTrue's
// catalogue. Anything unmapped falls through to a decision based on its status, which is the right
// amount of confidence for a list assembled from a handful of probes.
const AUTH_ERROR_OVERRIDES = new Map([
  // §4.B requires this exact body. GoTrue answers 400 with `invalid_credentials` for a wrong
  // password AND for an unknown account, which is why 401 here carries one message for both.
  ['invalid_credentials', { status: 401, message: 'Invalid login credentials' }],
  [
    'user_already_exists',
    // Honest status for the condition, and a note on what it costs: this tells a caller that an
    // account exists. A production API should instead answer 201 as if it had created the account
    // and mail the real user; doing that here would hide the behaviour the assignment asks to see.
    { status: 409, message: 'an account with that email already exists' },
  ],
  // Let the provider's own wording through: "Password should be at least 6 characters." is advice the
  // caller can act on, and the policy belongs to Supabase rather than being duplicated here.
  ['weak_password', { status: 400, passthrough: true }],
  ['validation_failed', { status: 400, passthrough: true }],
  // Listed for hosted projects. NOT observed: this local stack autoconfirms email, so signup returns
  // a session and this path never fires here. Untested on purpose rather than tested against a fake
  // and then described as proven.
  ['email_not_confirmed', { status: 403, message: 'email address is not confirmed' }],
]);

function providerMessage(error) {
  const text = typeof error?.message === 'string' ? error.message.trim() : '';
  if (!text) return null;
  // A cap, because a provider message ends up in a response body and an unbounded one is a
  // reflection vector nobody asked for.
  return text.length > 200 ? `${text.slice(0, 200)}…` : text;
}

function describeAuthError(error) {
  const override = AUTH_ERROR_OVERRIDES.get(error?.code);
  if (override) {
    const message = override.passthrough ? providerMessage(error) : override.message;
    // Fall back to the generic wording if the provider sent a code but no usable text.
    if (message) return new HttpError(override.status, message);
  }

  const status = typeof error?.status === 'number' ? error.status : 0;

  // A verification failure is answered generically, never with what was wrong about the token. Routes
  // that verify a bearer use describeVerificationError below, which is this rule applied to every
  // rejection rather than only to the two statuses seen so far.
  if (status === 401 || status === 403) return new HttpError(401, INVALID_TOKEN);
  if (status >= 400 && status < 500) {
    const message = providerMessage(error);
    return message
      ? new HttpError(400, message)
      : new HttpError(400, 'request was rejected by the authentication service');
  }

  // No status means the request never got an answer — a network failure, or a 5xx that supabase-js
  // surfaced as AuthRetryableFetchError. This is 502 and NOT 401: telling a caller their token is bad
  // when it was our identity provider that was unreachable is a lie that sends them to log in again.
  return new HttpError(502, 'authentication service is unreachable');
}

// ---------------------------------------------------------------------------
// Describing a failure for a caller who arrived with a bearer token.
//
// The rule is deliberately blunter than the one above: on a verification route, any answer from
// GoTrue that says "this token does not describe a live session" is the same answer to our caller,
// and it is not their job to know which of those checks failed. Observed shapes on /auth/v1/user:
//
//   AuthApiError           status 403, code 'bad_jwt'  — expired, wrong signature, not a JWT
//   AuthSessionMissingError status 400, no code        — the session was revoked (logout), or the
//                                                        token names a `session_id` that does not exist
//
// The second one is the reason this function exists at all. supabase-js downgrades GoTrue's 403
// `session_not_found` into an `AuthSessionMissingError` carrying status 400 and no code, so routing
// a verification failure through `describeAuthError` made a revoked session answer
// `400 {"error":"Auth session missing!"}` — the library's internal wording, reflected in our response
// body, for a condition §4.D says must be a generic 401. Both shapes above were read off the local
// stack rather than assumed, and test/unit.token-verification.test.js keeps them from drifting.
// ---------------------------------------------------------------------------

// The statuses GoTrue answers with when the token is the problem. Anything else is treated as our
// outage rather than their bad token, which is the safer mistake in both directions.
const TOKEN_REJECTION_STATUSES = new Set([400, 401, 403]);

function describeVerificationError(error) {
  const status = typeof error?.status === 'number' ? error.status : 0;
  if (TOKEN_REJECTION_STATUSES.has(status)) return new HttpError(401, INVALID_TOKEN);
  // No status at all: the request never reached GoTrue or never got an answer. Same wording the login
  // path uses, because it is the same fact.
  if (!status) return new HttpError(502, 'authentication service is unreachable');
  // 429, a 5xx: it answered, and what it said was not about the token. Kept as 502 with its own
  // wording rather than reusing "unreachable", which would be a guess about a cause we have not
  // observed here.
  return new HttpError(502, 'authentication service could not verify this token');
}

// What a failed sign-out means for the caller. Its own translator, because the two existing ones
// would both be wrong here: describeAuthError could reflect GoTrue's wording about a session back into
// the response, and describeVerificationError's "could not verify this token" is a statement about a
// token we have already verified — the middleware in src/middleware/auth.js vouched for it seconds
// before this call failed.
//
// The rule that matters: a sign-out that did not happen is never reported as a 204. Telling someone
// they are logged out when their session is still live is worse than telling them it failed, because
// they will stop worrying about the machine they are on.
function describeSignOutError(error) {
  const status = typeof error?.status === 'number' ? error.status : 0;
  if (!status) return new HttpError(502, 'authentication service is unreachable');
  // The token verified (otherwise the middleware refused already) but there is no session for it to
  // end — a token minted outside a real sign-in, or one whose session was already cut. Their
  // credentials are what need replacing, so this stays a 401 and says no more than that.
  if (status === 401 || status === 403) return new HttpError(401, INVALID_TOKEN);
  return new HttpError(502, 'sign-out could not be completed');
}

// supabase-js reports failures two ways: a returned `{ data, error }` for anything GoTrue answered,
// and a genuine throw for the rarer cases. Both must end up in this API's `{"error": ...}` envelope,
// so both go through here and a handler never has to remember to check twice.
//
// `describe` is which translator to use: the nuance-preserving one for a signup/login, where the
// caller is being told what to fix, or the blunt one for a bearer token, where they are not.
async function authCall(work, describe = describeAuthError) {
  let result;
  try {
    result = await work();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw describe(error);
  }
  if (result.error) throw describe(result.error);
  return result.data;
}

// Only the fields a caller is entitled to see, named one by one. Spreading `...user` would put
// `encrypted_password` on some GoTrue versions, plus `identities`, `app_metadata`, `role` and
// `phone` — none of which this API has any reason to hand out. See §4.D.
function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email ?? null,
    createdAt: user.created_at ?? null,
    emailConfirmedAt: user.email_confirmed_at ?? null,
  };
}

// camelCase, because every other body in this API is camelCase — `publicUser` above converts too.
// The cost is that a browser client cannot paste this straight into `supabase.auth.setSession()`,
// which wants `access_token` / `refresh_token`; the README shows the two-line mapping instead of
// quietly shipping mixed conventions.
function publicSession(session) {
  if (!session) return null;
  return {
    accessToken: session.access_token,
    refreshToken: session.refresh_token,
    tokenType: session.token_type ?? 'bearer',
    expiresIn: session.expires_in ?? null,
  };
}

module.exports = {
  INVALID_TOKEN,
  authCall,
  createSupabaseClient,
  describeAuthError,
  describeSignOutError,
  describeVerificationError,
  publicSession,
  publicUser,
  signOutAs,
};
