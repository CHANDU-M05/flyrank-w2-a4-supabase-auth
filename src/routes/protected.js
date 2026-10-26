// The route not everyone may see.
//
// Stage 2 let any well-shaped bearer through. Stage 3 asks Supabase who that token actually belongs
// to, and answers with that person's own details and nobody else's.
const express = require('express');

const { HttpError } = require('../errors');
const { asyncHandler, readBearer } = require('../http');
const { INVALID_TOKEN, authCall, describeVerificationError, publicUser } = require('../supabase');

function createProtectedRouter({ supabase }) {
  const router = express.Router();

  router.get(
    '/profile',
    asyncHandler(async (request, response) => {
      // Two different questions, asked in this order:
      //   readBearer  — is there a bearer token in the header at all? Format only, no network.
      //   getUser     — does Supabase recognise this token, and whose is it?
      // Doing the first one first means a request with no header never costs a call to the identity
      // provider, which is the cheap version of not letting strangers set the bill.
      const token = readBearer(request);

      // After the shape check on purpose: someone who sent no token is unauthorised whatever our
      // configuration looks like, and telling them 503 would be answering for the wrong reason. But a
      // caller who *did* send one is not told their token is invalid when the truth is that we have
      // nothing to verify it against — that is 503, and it is not their fault.
      if (!supabase) {
        throw new HttpError(503, 'authentication is not configured');
      }

      // The verification translator rather than the login one: on this route every rejection GoTrue
      // answers is the same generic 401, and its wording never reaches the caller. Passing
      // describeAuthError here is what made a revoked session answer `400 "Auth session missing!"`.
      const data = await authCall(() => supabase.auth.getUser(token), describeVerificationError);

      // §4.D asks for both halves of the check, and they catch different things: supabase-js can
      // resolve with an error (bad signature, expired, revoked) and it can also resolve with no error
      // *and* no user. Trusting either one alone is how a route starts answering 200 for a caller it
      // never identified. The `id` test is the same rule taken one step further: an identity this API
      // cannot name is not an identity it should be confirming, and returning `{ email: null, … }`
      // with a 200 would be a success the caller cannot act on.
      const user = publicUser(data?.user);
      if (!user || !user.id) {
        throw new HttpError(401, INVALID_TOKEN);
      }

      response.json(user);
    }),
  );

  return router;
}

module.exports = { createProtectedRouter };
