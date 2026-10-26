// The route not everyone may see.
//
// `GET /protected/profile` is where an identity will be answered from. At this stage it answers with
// no identity at all, and that is deliberate — read the note on the handler before changing it.
const express = require('express');

const { readBearer } = require('../http');

function createProtectedRouter() {
  const router = express.Router();

  router.get('/profile', (request, response) => {
    // The gate so far is `readBearer()`: a header that looks like a bearer token gets through, and a
    // token is not checked against anything. That is the weakest state this route can honestly be
    // left in, so it is left answering with something that is true whatever the caller submitted and
    // reveals nobody — no user id, no email, nothing read out of the token.
    //
    // `verified: false` is not a field that survives the next commit. Stage 3 puts
    // `supabase.auth.getUser()` in front of this handler and replaces the body with the caller's own
    // identity. If this ever ships with `verified: false` still on it, the verification was forgotten.
    readBearer(request);
    response.json({ reachable: true, verified: false });
  });

  return router;
}

module.exports = { createProtectedRouter };
