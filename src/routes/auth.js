// Signup and login — the two routes that talk to Supabase on a caller's behalf.
//
// What this file deliberately does NOT do: it never hashes a password, never stores one, never signs
// or decodes a token, and never decides on its own whether a password is strong enough. Those are the
// identity provider's jobs. A backend that starts managing its own password hashes has quietly become
// a second, badly-implemented auth system, and the brief bans exactly that: Supabase owns credentials,
// this route passes them along once and forgets them.
const express = require('express');

const { HttpError } = require('../errors');
const { asyncHandler, requireObject } = require('../http');

// A shape check, not a deliverability check. It exists so "hello" and "a@b" get a 400 from us rather
// than a 400 translated from GoTrue, and it accepts anything address-shaped because whether the
// mailbox is real is exactly what email confirmation is for.
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// The one place that turns a Supabase error into an HTTP answer. Supabase's AuthApiError carries a
// stable `code`, the `status` GoTrue answered with and a human `message` — all three observed against
// the local stack (see the note on `email_not_confirmed` below), so this maps on `code` and treats
// `message` as display text rather than something to pattern-match.
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

  // Token problems arrive as 401/403 from GoTrue. Names stay generic: this is the answer that gets
  // returned to someone holding a bad token, and a precise one would tell them what to fix.
  if (status === 401 || status === 403) return new HttpError(401, 'Invalid or expired token');
  if (status >= 400 && status < 500) {
    const message = providerMessage(error);
    return message ? new HttpError(400, message) : new HttpError(400, 'request was rejected by the authentication service');
  }

  // No status means the request never got an answer — a network failure, or a 5xx that supabase-js
  // surfaced as AuthRetryableFetchError. The caller needs to know auth is down; it does not need our
  // DNS, our upstream host or the fetch library's phrasing, so `error.message` is not passed through.
  return new HttpError(502, 'authentication service is unreachable');
}

// supabase-js reports failures two ways: a returned `{ data, error }` for anything GoTrue answered,
// and a genuine throw for the rarer cases. Both must end up in this API's `{"error": ...}` envelope,
// so both go through here and a handler never has to remember to check twice.
async function authCall(work) {
  let result;
  try {
    result = await work();
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw describeAuthError(error);
  }
  if (result.error) throw describeAuthError(result.error);
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

function cleanEmail(value) {
  if (value === undefined || value === null) throw new HttpError(400, 'email is required');
  if (typeof value !== 'string' || value.trim() === '') throw new HttpError(400, 'email must be a non-empty string');
  // Supabase looks accounts up case-insensitively, so normalising here means `Admin@X.com` and
  // `admin@x.com` cannot become two accounts that a later login has to guess between.
  const email = value.trim().toLowerCase();
  if (!EMAIL_SHAPE.test(email)) throw new HttpError(400, 'email must be a valid email address');
  return email;
}

function cleanPassword(value) {
  if (value === undefined || value === null) throw new HttpError(400, 'password is required');
  if (typeof value !== 'string' || value === '') throw new HttpError(400, 'password must be a non-empty string');
  // Not trimmed, on purpose: a leading or trailing space is part of the secret. `email` is an
  // identifier and gets normalised; a password is not.
  return value;
}

function createAuthRouter({ supabase }) {
  const router = express.Router();

  // The app builds a client whenever SUPABASE_URL and SUPABASE_KEY are set. If they are not, auth
  // routes answer 503 rather than 404: the route exists, the dependency does not, and a caller
  // told "not found" would go looking for a typo in their own URL.
  router.use((request, response, next) => {
    if (!supabase) {
      return next(new HttpError(503, 'authentication is not configured'));
    }
    next();
  });

  router.post(
    '/signup',
    asyncHandler(async (request, response) => {
      const body = requireObject(request.body);
      const email = cleanEmail(body.email);
      const password = cleanPassword(body.password);

      const data = await authCall(() => supabase.auth.signUp({ email, password }));

      const user = publicUser(data.user);
      if (!user) {
        // A 2xx with no user is not a signup that worked. Saying so is better than answering 201
        // with `{ user: null }`, which a client reads as success.
        throw new HttpError(502, 'authentication service returned no user');
      }

      // `session` is null on a project that requires email confirmation: the account exists, but
      // there is no verified identity to hand a token for yet.
      response.status(201).json({ user, session: publicSession(data.session) });
    }),
  );

  router.post(
    '/login',
    asyncHandler(async (request, response) => {
      const body = requireObject(request.body);
      const email = cleanEmail(body.email);
      const password = cleanPassword(body.password);

      const data = await authCall(() => supabase.auth.signInWithPassword({ email, password }));

      if (!data?.session?.access_token || !data.user) {
        throw new HttpError(502, 'authentication service returned no session');
      }

      // The access token is the thing the next request will be made with, and the refresh token
      // outlives it. Both are returned because §4.B asks for both, and neither is ever logged.
      response.status(200).json({ user: publicUser(data.user), session: publicSession(data.session) });
    }),
  );

  return router;
}

module.exports = {
  createAuthRouter,
  // Exported for the tests: these are the parts with rules in them, and a router is not needed to
  // check that a password survives a trim or that a code maps to a status.
  cleanEmail,
  cleanPassword,
  describeAuthError,
  publicSession,
  publicUser,
};
