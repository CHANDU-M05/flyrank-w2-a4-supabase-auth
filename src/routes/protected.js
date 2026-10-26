// The routes not everyone may see.
//
// Stage 3 asked Supabase who a bearer token belonged to, with the verification written inside the
// profile handler. Stage 4 moves that into `middleware/auth.js` and puts two routes behind it — which
// is the point of the middleware: the second route proves the first one's logic is not private to it,
// and there is now exactly one place that decides what a verified identity is.
const express = require('express');

function createProtectedRouter({ requireAuth }) {
  const router = express.Router();

  // Mounted once for the whole prefix instead of repeated per route, which is the safer trade:
  // listing the middleware on each route means a `/protected/anything` added later is public until
  // someone remembers, while this way it is refused until someone decides otherwise. The visible
  // consequence is that an unknown path under /protected answers 401 to a caller who sent no token
  // rather than 404 — we ask who they are before we tell them what does not exist. A caller who *has*
  // verified still gets the ordinary 404, which the tests pin down.
  router.use(requireAuth);

  // Both handlers below are synchronous, so neither needs asyncHandler: the verification that could
  // reject already happened in the middleware, and `request.user` is either there or this code is
  // never reached.
  router.get('/profile', (request, response) => {
    // The four fields §4.D allows, with no second decision about whose they are.
    response.json(request.user);
  });

  router.get('/dashboard', (request, response) => {
    // §5's reuse proof: a second protected route, no verification code of its own, and only the `id`
    // from the verified user — a dashboard greeting has no reason to carry an email address.
    response.json({
      message: 'This is your dashboard.',
      userId: request.user.id,
    });
  });

  return router;
}

module.exports = { createProtectedRouter };
