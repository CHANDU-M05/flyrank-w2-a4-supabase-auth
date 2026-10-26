# Week 2 · A4 — Supabase Auth + protected Express API

A small Express backend that delegates authentication to Supabase and guards part of its own API with
the access tokens that authentication hands out. It never stores a password, never hashes one, never
signs a JWT and never decodes one itself — it asks the identity provider `supabase.auth.getUser(token)`
who a bearer belongs to. That distinction ("this JWT parses" vs "the provider vouches for it") is the
whole point of the assignment.

Built on the task CRUD carried over from Weeks 2/3, so `/tasks`, `/stats` and `/reset` still work
against Postgres exactly as before. Everything new lives under `/auth`, `/public` and `/protected`.

---

## Endpoints

| Method | Path | Auth | Success | Notable failures |
| --- | --- | --- | --- | --- |
| `POST` | `/auth/signup` | none | `201 { user, session }` | `400` validation / weak password, `409` email taken, `503` auth not configured |
| `POST` | `/auth/login` | none | `200 { user, session }` | `400` validation, `401 {"error":"Invalid login credentials"}`, `503` |
| `POST` | `/auth/logout` | **bearer** | `204` (empty body) | `401` no/invalid token, `502` provider failure |
| `GET` | `/public/info` | none | `200 {"message":"Welcome stranger! This info is public."}` | — |
| `GET` | `/protected/profile` | **bearer** | `200 { id, email, createdAt, emailConfirmedAt }` | `401 {"error":"Access token required"}` / `401 {"error":"Invalid or expired token"}`, `502` |
| `GET` | `/protected/dashboard` | **bearer** | `200 { message, userId }` | same 401s as `/profile` |
| `GET` | `/docs` | none | Swagger UI (HTML) | — |
| `GET` | `/openapi.json` | none | OpenAPI 3.0.3 document | — |
| `GET` | `/health` | none | `200 {"status":"ok"}` | `503` database unreachable |
| `GET` | `/` | none | route index | — |

`user` is always exactly four fields (`id`, `email`, `createdAt`, `emailConfirmedAt`). The provider's
user object carries `encrypted_password`, `identities`, `app_metadata`, `phone` and more; none of that
ever leaves the process. `session` is `{ accessToken, refreshToken, tokenType, expiresIn }` (camelCase,
mapped from GoTrue's snake_case — see the note under “Using the token” for why that matters to a browser
client), or `null` on a project with email confirmation required.

The three bearer routes are protected by **one shared middleware instance** (`src/middleware/auth.js`),
built once in `createApp` and handed to each router — there is no second copy of the verification rules
that could drift. Because it is mounted over the whole `/protected` prefix, an unknown path under it
answers `401` to a caller who cannot verify rather than `404` (a caller who *does* verify still gets an
ordinary `404` for a typo). That fail-closed trade-off is deliberate.

---

## Setup

```bash
cp .env.example .env      # then fill in the four values
npm install
npm run migrate           # create/seed the Postgres tables the task CRUD needs
npm start                 # or: npm run dev   (node --watch)
```

Configuration lives in `.env`, which is git-ignored and must never be committed. `.env.example` is the
committed template. The variables:

- `SUPABASE_URL` — the project URL.
- `SUPABASE_KEY` — the **publishable / `anon`** key only. `src/config.js` refuses to start if you paste
  an `sb_secret_…` or a legacy `service_role` key (see Security below).
- `PORT` — HTTP port (default 3000).
- `DATABASE_URL` — Postgres connection, used only by the inherited task CRUD.

### Running it with no cloud account

The pinned `supabase` CLI can bring the whole stack up on localhost:

```bash
npx supabase start        # prints the values for the four variables above
# ... work ...
npx supabase stop --no-backup   # tears the containers down and clears throwaway dev data
```

Point `.env` at the URL/keys it prints (Auth via Kong at `http://127.0.0.1:54321` — put that host in
`SUPABASE_URL` and let the client add `/auth/v1` itself). `npx supabase stop --no-backup` is how you
clear the throwaway `@flyrank.test` accounts the integration tests create.

---

## Trying it with curl

`-i` shows the status line and headers, which is where the interesting parts of this API live.

**Sign up:**

```bash
curl -i -X POST http://localhost:3000/auth/signup \
  -H 'content-type: application/json' \
  -d '{"email":"you@example.com","password":"correct-horse-battery-staple"}'
```

**Log in** (on the local stack, which autoconfirms email, this returns a session):

```bash
curl -i -X POST http://localhost:3000/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"you@example.com","password":"correct-horse-battery-staple"}'
```

A wrong password and an unknown account both get the identical `401 {"error":"Invalid login credentials"}`.

**Use the token.** Copy `session.accessToken` from the login response:

```bash
TOKEN="<paste session.accessToken>"

curl -i http://localhost:3000/protected/profile -H "Authorization: Bearer $TOKEN"
curl -i http://localhost:3000/protected/dashboard -H "Authorization: Bearer $TOKEN"
```

**…or don't**, and see the difference the middleware is there to make:

```bash
curl -i http://localhost:3000/protected/profile
# 401 {"error":"Access token required"}

curl -i http://localhost:3000/protected/profile -H "Authorization: Bearer nonsense"
# 401 {"error":"Invalid or expired token"}

curl -i http://localhost:3000/public/info
# 200 {"message":"Welcome stranger! This info is public."}   (a bad bearer does not turn this into a 401)
```

**Log out** (needs the bearer — `logout` is behind the same middleware):

```bash
curl -i -X POST http://localhost:3000/auth/logout -H "Authorization: Bearer $TOKEN"
# 204, empty body

curl -i http://localhost:3000/protected/profile -H "Authorization: Bearer $TOKEN"
# 401 {"error":"Invalid or expired token"}  — the session behind that token is gone
```

---

## API documentation (`/docs`)

Swagger UI is served at **`/docs`**, rendered from an OpenAPI 3.0.3 document that lives in
`src/docs.js` and is also reachable at **`/openapi.json`**. The document defines an HTTP **bearer**
security scheme (`scheme: bearer`, `bearerFormat: JWT`) and attaches it to exactly the three protected
operations — `GET /protected/profile`, `GET /protected/dashboard`, `POST /auth/logout` — and to nothing
else.

To use a token in the UI: `POST /auth/login`, copy `session.accessToken`, click **Authorize**, paste it,
then **Try it out** on a protected route.

> **Note on the screenshot.** §8 asks to verify Authorize + Try-it-out and include a screenshot. This
> development environment has no browser and no headless runtime (no puppeteer/playwright/chromium), so
> a genuine screenshot could not be captured and none is included here — that is stated rather than faked.
> What *was* verified is the substance behind the UI, at the wire level: the exact `Authorization: Bearer`
> header the Authorize box sends was issued by a real login against the local Supabase and used
> successfully on the protected routes (full token round-trip, tampered token → 401, logout → the token
> stops verifying). The served `/openapi.json` and the UI assets are covered by the test suite
> (`test/unit.swagger.test.js`, which asserts the bearer scheme and that `security` appears on exactly
> those three operations and none other, and that `/docs`, its css/js bundles and the oauth2-redirect
> route all serve), and the same routes were confirmed live over HTTP against the running server.

---

## Security notes

These are the findings worth reading before you reuse any of this. Where marked **measured**, the claim
was checked against the running local Supabase, not assumed.

- **The service-role / secret key is refused at boot.** `src/config.js` exits if `SUPABASE_KEY` starts
  with `sb_secret_` or decodes to a JWT with `role: service_role`. That key bypasses Row Level Security
  for every request, so it must never be given to a server whose job is only to verify *who a bearer
  belongs to*. Use the publishable/`anon` key and let RLS protect the data.
- **This API returns only four user fields, ever.** Verification goes through `supabase.auth.getUser`,
  which checks the signature, expiry *and* that the session is still live — not a local decode that
  would accept any well-formed token.
- **Passwords and tokens are never logged.** The request log records method, path, status and duration
  only. No `Authorization` line, no body, no provider secret reaches stdout.
- **Logout is `scope = global` (measured).** It ends the user's *every* session at the provider, so
  signing out on one device signs out the others. The access token you held then gets `401` and its
  refresh token is refused (`400 refresh_token_not_found`). Signing in again works — this is a sign-out,
  not an account lockout. Use `local` or `others` if you need narrower scope.
- **Logout does *not* invalidate every already-issued token, and this API does not claim it does.**
  Nothing is re-signed and no token is blacklisted here (the server is stateless). A normal token stops
  working only because the provider stops vouching for the session behind it; the JWT itself is still
  cryptographically valid until `exp`.
- **Legacy symmetric JWT secret = impersonation + forced sign-out (measured, inherited risk).** This
  stack issues ES256 tokens (`kid` in the header), but GoTrue *also* still verifies HS256 tokens signed
  with the legacy `GOTRUE_JWT_SECRET`. A token forged from that secret carries no `session_id`, so:
  it keeps verifying after any logout and cannot be revoked through this API; using another user's `sub`
  in it returns that user's profile; and using it to call `/auth/logout` signs the real user out of all
  their devices. Whoever holds that secret can read any account and log any account out. **Mitigation:**
  disable the legacy secret / migrate fully to asymmetric JWT keys; never expose `GOTRUE_JWT_SECRET`.
  This is provider configuration, not this route's behaviour, but any README that implied verification
  proved provenance would be lying, so it is stated here.
- **Signup enumerates accounts with `409` (deliberate, and it costs something).** A real signup with an
  email that exists returns `409 an account with that email already exists`. A production API would
  instead return `201` as if it had created the account and email the real user, to deny enumeration.
  The honest status was kept because the assignment asks to see the behaviour; the trade-off is a known
  one.
- **`401` before `503`.** On the bearer routes, a caller who sent no/invalid token is answered `401`
  before any configuration error is considered — your credentials are your problem to fix first, and a
  config fault must not answer on your behalf.

---

## Testing

```bash
npm test                 # 152 unit tests, 23 suites — no credentials, no network, no database
npm run test:integration # 9 checks against the real local Supabase (must be running)
```

The unit suite boots the real Express app on an ephemeral port and drives it with Node's own `fetch`
against a fake Supabase client and an in-memory repository, so it exercises real routing, real error
translation and real 204/404 semantics with no external dependency. `test/*.test.js` deliberately
excludes `test/integration/`, which is opt-in because it creates throwaway accounts and hits the
network. The integration file characterises the logout and legacy-token behaviour above against the real
provider, and fails loudly (rather than reporting green) if the stack is not running.

---

## Layout

```
src/
  index.js            boot: config, pool, supabase client, signOut binding, listen
  app.js              createApp({ tasks, supabase, signOut, log }) — everything a test needs
  config.js           env -> validated config; refuses a secret/service_role key
  docs.js             the OpenAPI 3.0.3 document (served at /openapi.json, rendered at /docs)
  http.js             asyncHandler, readBearer, requireObject, HttpError helpers
  supabase.js         client + signOutAs + the auth/verification/sign-out error translators
  middleware/auth.js  the shared bearer gate that sets req.user
  routes/             auth.js (signup/login/logout), public.js, protected.js (profile/dashboard), tasks.js
  db/, repositories/  the inherited Week 2/3 task CRUD
test/
  *.test.js           unit suite (no network)
  integration/        opt-in checks against a real Supabase
```
