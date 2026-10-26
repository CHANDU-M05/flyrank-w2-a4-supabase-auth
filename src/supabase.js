// One reusable Supabase client, plus the one auth operation that cannot be done with a shared
// client.
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
// What it does NOT do is invalidate the bearer you already handed out. That JWT stays
// cryptographically valid until `jwt_expiry` passes. See the README and the integration test, which
// measures this instead of assuming it.
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

module.exports = { createSupabaseClient, signOutAs };
