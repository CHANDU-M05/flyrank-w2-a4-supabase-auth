// The one place that turns an Authorization header into a verified identity.
//
// §5 asks for this as a module rather than as a few lines copied into each route, and the reason it is
// worth a file is that verification has decisions in it that no route should be re-making: which
// header shapes to refuse, what to do when the provider is down versus when the token is bad, which
// fields may be handed downstream, and what wording leaves the process. Copy that and the copies drift.
//
// What it does NOT do: verify a signature locally. `supabase.auth.getUser(token)` asks the provider,
// which is the difference between "this JWT is well-formed and decodes" and "Supabase says this token
// belongs to a user". Stage 2 showed what the first one is worth — a forged but decodable token walked
// straight through — and decoding a token here would only re-derive an answer we then have to trust
// the provider to confirm anyway.
const { HttpError } = require('../errors');
const { asyncHandler, readBearer } = require('../http');
const { INVALID_TOKEN, authCall, describeVerificationError, publicUser } = require('../supabase');

function createAuthMiddleware({ supabase }) {
  return asyncHandler(async (request, _response, next) => {
    // Format first, no network: a request that never offered a token is unauthorised whatever the
    // provider thinks, and it costs nothing to say so.
    const token = readBearer(request);

    // After the shape check on purpose. Someone who sent no token is unauthorised regardless of our
    // configuration; someone who did send one is not told their token is invalid when the truth is
    // that we have nothing to verify it against — that is 503, and it is not their fault.
    if (!supabase) {
      throw new HttpError(503, 'authentication is not configured');
    }

    const data = await authCall(() => supabase.auth.getUser(token), describeVerificationError);

    // Both halves of §4.D's check, because they catch different failures: an error the provider
    // answered, and a response that carried neither an error nor anyone to identify. `publicUser`
    // narrows to the four documented fields on the way, so what lands on `request.user` is already
    // the safe representation rather than the raw provider object with its `encrypted_password`,
    // `app_metadata` and `role` still attached.
    const user = publicUser(data?.user);
    if (!user || !user.id) {
      throw new HttpError(401, INVALID_TOKEN);
    }

    request.user = user;
    next();
  });
}

module.exports = { createAuthMiddleware };
