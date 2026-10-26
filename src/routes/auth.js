// Signup, login and logout — the three routes that talk to Supabase on a caller's behalf.
//
// What this file deliberately does NOT do: it never hashes a password, never stores one, never signs
// or decodes a token, and never decides on its own whether a password is strong enough. Those are the
// identity provider's jobs. A backend that starts managing its own password hashes has quietly become
// a second, badly-implemented auth system, and the brief bans exactly that: Supabase owns credentials,
// this route passes them along once and forgets them.
const express = require('express');

const { HttpError } = require('../errors');
const { asyncHandler, readBearer, requireObject } = require('../http');
// Error translation and the user/session representations come from src/supabase.js, the module that
// owns talking to the provider — Stage 3 gave the protected route the same needs, and a route file is
// not a sensible home for vocabulary two routes share.
const { authCall, describeSignOutError, publicSession, publicUser } = require('../supabase');

// A shape check, not a deliverability check. It exists so "hello" and "a@b" get a 400 from us rather
// than a 400 translated from GoTrue, and it accepts anything address-shaped because whether the
// mailbox is real is exactly what email confirmation is for.
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

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

function createAuthRouter({ supabase, requireAuth, signOut = null }) {
  const router = express.Router();

  // The app builds a client whenever SUPABASE_URL and SUPABASE_KEY are set. If they are not, the
  // routes that spend a caller's credentials answer 503 rather than 404: the route exists, the
  // dependency does not, and a caller told "not found" would go looking for a typo in their own URL.
  //
  // Applied per route rather than as a `router.use` over the whole mount, because /logout has a check
  // that must come first: someone who sent no bearer token is unauthorised whatever our configuration
  // looks like, and they should hear that before hearing about our environment. That is the ordering
  // /protected/profile has used since Stage 3, and two different orderings inside one API is how
  // "which comes first" becomes folklore.
  const requireSupabase = (request, response, next) => {
    if (!supabase) {
      return next(new HttpError(503, 'authentication is not configured'));
    }
    next();
  };

  router.post(
    '/signup',
    requireSupabase,
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
    requireSupabase,
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

  // §4.E. Behind the same middleware as /protected/profile, which is the reuse proof: this route does
  // not verify anything itself, it just spends the identity the middleware confirmed.
  //
  // The token is re-read from the header rather than taken off the request. That is deliberate:
  // §5 says `req.user` carries *user information*, and stashing the bearer on the request object
  // would put a live credential somewhere a future `console.log(req)` or a request-dumping error
  // handler can find it. readBearer is a format check with no cost, so spending it twice is cheaper
  // than holding a secret in memory for the lifetime of the request.
  router.post(
    '/logout',
    requireAuth,
    asyncHandler(async (request, response) => {
      // After the middleware on purpose, for the same reason as the 503 in src/middleware/auth.js: a
      // caller who sent no token is unauthorised whatever this server is configured with.
      if (!signOut) {
        throw new HttpError(503, 'sign-out is not configured');
      }

      try {
        await signOut({ accessToken: readBearer(request) });
      } catch (error) {
        if (error instanceof HttpError) throw error;
        throw describeSignOutError(error);
      }

      // 204 with an empty body, §4.E. `.end()` rather than `.json({})`: a 204 that carries a body is
      // malformed HTTP, and some clients treat the mismatch as a reason to drop the response.
      response.status(204).end();
    }),
  );

  return router;
}

module.exports = {
  createAuthRouter,
  // Exported for the tests: these are the parts with rules in them, and a router is not needed to
  // check that a password survives a trim. The error mapping and the user/session representations are
  // tested through src/supabase.js, where they now live.
  cleanEmail,
  cleanPassword,
};
