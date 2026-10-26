// The OpenAPI document served at /docs by swagger-ui-express.
//
// Written as a JavaScript object rather than a YAML file so it can be checked by the test suite: a
// document that disagrees with the routes is worse than none, and the only way to know the two agree is
// to compare them in code. `createOpenApiDocument` takes the name and version from src/app.js instead of
// restating them — the same reason the task contract is ported rather than paraphrased everywhere.
//
// Scope: the five endpoints §4 requires, the optional /protected/dashboard §5 adds, and /health for
// anyone probing whether this server is up. The task CRUD carried over from Weeks 2/3 is not described
// here — `GET /` lists it, and the README points at the Week 3 assignment for its contract. Leaving it
// out is a decision, not an oversight, so it is said in the document's own description too.
function createOpenApiDocument({ name, version }) {
  return {
    openapi: '3.0.3',
    info: {
      title: name,
      version,
      description: [
        'Supabase Authentication and a protected Express API (FlyRank Backend, Week 2, A4).',
        '',
        'Sign up and log in through Supabase Auth, then spend the access token you get back on the',
        'protected routes. This server never stores a password, never signs a token and never decodes',
        'one: it asks `supabase.auth.getUser(token)` who a bearer belongs to, which is the difference',
        'between "this JWT parses" and "the identity provider vouches for it".',
        '',
        'How to try the protected routes: POST /auth/login, copy `session.accessToken`, click Authorize',
        'and paste it there (or set it on one request with the little "Try it out" arrow). A token from',
        'another project, an expired one, or one whose signature was touched will all get the same',
        'answer: 401 {"error":"Invalid or expired token"}.',
        '',
        'Not documented here: the task CRUD carried over from Weeks 2/3 (/tasks, /stats, /reset) and',
        '/reset. `GET /` lists every route this process serves.',
      ].join('\n'),
    },
    servers: [{ url: '/', description: 'this server' }],
    tags: [
      { name: 'auth', description: 'credentials in, tokens out' },
      { name: 'public', description: 'no token accepted or required' },
      { name: 'protected', description: 'all three require a Bearer token issued by Supabase for this project' },
      { name: 'ops', description: 'liveness' },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: [
            'The `access_token` from POST /auth/signup or POST /auth/login, sent as',
            '`Authorization: Bearer <access_token>`.',
            '',
            'The refresh token does not belong in this header — it is for the auth provider to mint new',
            'access tokens, not for authorising requests to this API.',
          ].join('\n'),
        },
      },
      schemas: {
        User: {
          type: 'object',
          description: 'The fields this API is willing to say about an account. Nothing else on the Supabase user object leaves the process.',
          properties: {
            id: { type: 'string', format: 'uuid', example: '1f2c9a5e-8b3f-4c1a-9e7d-2a6b0c1d4e8f' },
            email: { type: 'string', format: 'email', example: 'reader@example.com' },
            createdAt: { type: 'string', nullable: true, example: '2026-10-26T09:00:00.000000+00:00' },
            emailConfirmedAt: { type: 'string', nullable: true, example: '2026-10-26T09:00:00.000000+00:00' },
          },
        },
        Session: {
          type: 'object',
          description: 'Null on a project that requires email confirmation, where there is no verified identity to hand tokens for yet.',
          nullable: true,
          properties: {
            accessToken: { type: 'string', description: 'The value for the Authorization header. Shown as a length, never logged.' },
            refreshToken: { type: 'string', description: 'For the auth provider only. Rotates on use.' },
            tokenType: { type: 'string', example: 'bearer' },
            expiresIn: { type: 'integer', nullable: true, example: 3600 },
          },
        },
        Credentials: {
          type: 'object',
          required: ['email', 'password'],
          properties: {
            email: {
              type: 'string',
              format: 'email',
              description: 'Trimmed and lower-cased here, so `Admin@X.com` and `admin@x.com` are one account.',
              example: 'reader@example.com',
            },
            password: {
              type: 'string',
              minLength: 1,
              description: 'Never trimmed — surrounding spaces are part of the secret. Supabase owns any strength policy and says so with a 400.',
              example: 'correct-horse-battery-staple',
            },
          },
        },
        Dashboard: {
          type: 'object',
          properties: {
            message: { type: 'string', example: 'This is your dashboard.' },
            userId: { type: 'string', format: 'uuid', description: 'From the verified token, not from anything the caller typed.' },
          },
        },
        Error: {
          type: 'object',
          required: ['error'],
          properties: { error: { type: 'string', example: 'Invalid or expired token' } },
        },
      },
      responses: {
        Unauthorized: {
          description: 'No bearer token, or one shaped wrong, or one Supabase refused to vouch for. Two distinct messages: `Access token required` is the header, `Invalid or expired token` is the provider.',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
        },
        Misconfigured: {
          description: 'This server has no SUPABASE_URL / SUPABASE_KEY, so it cannot ask who a token belongs to.',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
        },
        ProviderUnreachable: {
          description: 'The identity provider was unreachable or answered with something that was not about this token. Deliberately NOT a 401: telling a caller their credentials are bad during our outage sends them logging in again and again.',
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
        },
      },
    },
    paths: {
      '/auth/signup': {
        post: {
          tags: ['auth'],
          summary: 'Create a Supabase account',
          description: 'Email and password go to Supabase and are then forgotten by this route. 400 on anything that is not an email-shaped string and a non-empty password.',
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Credentials' } } } },
          responses: {
            201: {
              description: 'Account created. On this local stack email confirmation is off, so a session comes back immediately.',
              content: { 'application/json': { schema: { type: 'object', properties: { user: { $ref: '#/components/schemas/User' }, session: { $ref: '#/components/schemas/Session' } } } } },
            },
            400: { description: 'Missing or malformed email or password, or the provider rejected one.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
            409: { description: 'An account with that email already exists. Chosen for honesty; it tells a caller the address is taken, which an account-enumeration defence would hide. See the README.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
            503: { $ref: '#/components/responses/Misconfigured' },
          },
        },
      },
      '/auth/login': {
        post: {
          tags: ['auth'],
          summary: 'Exchange credentials for a session',
          description: 'A wrong password and an unknown account get the identical 401 `Invalid login credentials`, because GoTrue does not distinguish them either.',
          requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Credentials' } } } },
          responses: {
            200: { description: 'A session for this account.', content: { 'application/json': { schema: { type: 'object', properties: { user: { $ref: '#/components/schemas/User' }, session: { $ref: '#/components/schemas/Session' } } } } } },
            400: { description: 'Missing or malformed email or password.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
            401: { description: 'Invalid login credentials.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
            503: { $ref: '#/components/responses/Misconfigured' },
          },
        },
      },
      '/public/info': {
        get: {
          tags: ['public'],
          summary: 'A route anyone may read',
          description: 'Sends no Authorization header to the provider, and ignores one if it arrives: a bad token must not turn a public route into a 401.',
          responses: {
            200: { description: 'The public message.', content: { 'application/json': { schema: { type: 'object', properties: { message: { type: 'string', example: 'Welcome stranger! This info is public.' } } } } } },
          },
        },
      },
      '/protected/profile': {
        get: {
          tags: ['protected'],
          summary: 'Whoever this token belongs to',
          security: [{ bearerAuth: [] }],
          responses: {
            200: { description: 'The verified user, and only the four documented fields.', content: { 'application/json': { schema: { $ref: '#/components/schemas/User' } } } },
            401: { $ref: '#/components/responses/Unauthorized' },
            502: { $ref: '#/components/responses/ProviderUnreachable' },
            503: { $ref: '#/components/responses/Misconfigured' },
          },
        },
      },
      '/protected/dashboard': {
        get: {
          tags: ['protected'],
          summary: 'The same middleware, a second route',
          description: 'Exists to prove verification is not private to /protected/profile: same middleware instance, no second copy of the rules, and only the user id in the body.',
          security: [{ bearerAuth: [] }],
          responses: {
            200: { description: 'A greeting and the verified user id.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Dashboard' } } } },
            401: { $ref: '#/components/responses/Unauthorized' },
            502: { $ref: '#/components/responses/ProviderUnreachable' },
            503: { $ref: '#/components/responses/Misconfigured' },
          },
        },
      },
      '/auth/logout': {
        post: {
          tags: ['auth', 'protected'],
          summary: 'End this caller\'s session at the provider',
          description: [
            'Behind the same middleware as the protected routes, and request-scoped: the bearer in the',
            'header names whose session ends. Nothing about "the current user" is stored on the server.',
            '',
            'What it does, measured against the local Supabase: a global sign-out revokes the sessions',
            'for that user, the access token you were holding then gets 401 `Invalid or expired token`',
            'on the protected routes, and its refresh token is refused by the provider. Signing in again',
            'works. `scope = global` means every device, not just this one.',
            '',
            'What it does not do: invalidate a token that has no session behind it. An access token',
            'minted from the project\'s symmetric JWT secret carries no `session_id`, keeps verifying',
            'after any logout, and can itself be used to sign the user out. See the README\'s security',
            'notes — that is inherited from the provider\'s dual-algorithm support, not from this route.',
          ].join('\n'),
          security: [{ bearerAuth: [] }],
          responses: {
            204: { description: 'Signed out. Empty body on purpose.' },
            401: { $ref: '#/components/responses/Unauthorized' },
            502: { $ref: '#/components/responses/ProviderUnreachable' },
            503: { $ref: '#/components/responses/Misconfigured' },
          },
        },
      },
      '/health': {
        get: {
          tags: ['ops'],
          summary: 'Postgres reachable?',
          responses: {
            200: { description: '{ "status": "ok" }.', content: { 'application/json': { schema: { type: 'object', properties: { status: { type: 'string', example: 'ok' } } } } } },
            503: { description: 'The database is not answering.', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
          },
        },
      },
    },
  };
}

module.exports = { createOpenApiDocument };
