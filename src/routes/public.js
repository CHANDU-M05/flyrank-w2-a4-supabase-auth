// The route anyone may see.
//
// `GET /public/info` exists for one reason: to prove the gate is not applied to everything. An API
// where every route demands a token cannot show a caller the difference, and a caller who cannot
// compare the two has no way to tell whether their token was accepted or simply never needed.
const express = require('express');

function createPublicRouter() {
  const router = express.Router();

  router.get('/info', (_request, response) => {
    // §4.C, verbatim: no auth, this message.
    response.json({ message: 'Welcome stranger! This info is public.' });
  });

  return router;
}

module.exports = { createPublicRouter };
