// Swagger UI and the OpenAPI document behind it (§6).
//
// The UI is only the readable copy of a declaration, and a declaration can be checked in code. That is
// what these tests are for: the dangerous failure is not a broken stylesheet, it is documentation that
// disagrees with the routes — a `security` list that quietly omits /auth/logout, a scheme typed as
// `apiKey`, a documented 200 for a route that now answers 401. Those are all invisible to someone
// clicking through the page and obvious to a test that compares the document with live responses.
//
// No credentials and no network, same rule as the rest of `npm test`: the app is booted with the fake
// Supabase client, and every assertion is about what this process serves.
const assert = require('node:assert/strict');
const { after, describe, test } = require('node:test');

const { createFakeSignOut, createFakeSupabase, fakeUser } = require('./helpers/fake-supabase');
const { createFakeTasks } = require('./helpers/fake-tasks');
const { bearer, closeAllTestServers, startTestApp } = require('./helpers/server');

after(closeAllTestServers);

async function docsApp() {
  const log = [];
  const app = await startTestApp({
    tasks: createFakeTasks(),
    // A client that vouches for any bearer, so the two protected-profile tests below get a real 200
    // body to compare against the schema. The default fake returns no user (a deliberate trap for
    // routes that trust `{ user: null, error: null }`), which would make those assertions vacuous.
    supabase: createFakeSupabase({ getUser: () => ({ data: { user: fakeUser() }, error: null }) }),
    signOut: createFakeSignOut(),
    log: (line) => log.push(line),
  });
  return { app, log };
}

async function document(app) {
  const response = await app.get('/openapi.json');
  assert.equal(response.status, 200, 'the document must be reachable for these tests to mean anything');
  return response.body;
}

// Walk the whole node so a stray $ref anywhere is caught, not only the ones in the paths.
function collectRefs(node, found = []) {
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === '$ref' && typeof value === 'string') found.push(value);
      else collectRefs(value, found);
    }
  }
  return found;
}

function resolveRef(doc, ref) {
  if (!ref.startsWith('#/')) return undefined; // external refs are not used in this document
  return ref.slice(2).split('/').reduce((node, part) => (node ? node[part] : undefined), doc);
}

describe('Swagger UI is served at /docs', () => {
  test('GET /docs returns the Swagger UI page', async () => {
    const { app } = await docsApp();
    const response = await app.get('/docs');

    assert.equal(response.status, 200);
    assert.match(String(response.headers.get('content-type')), /text\/html/, 'a browser gets a page, not JSON');
    assert.match(response.text, /swagger-ui/i, 'and it is actually the Swagger UI shell');
    await app.close();
  });

  test('the UI can still reach the document it renders and its own assets', async () => {
    // swagger-ui-express serves its dist files from the mount point (`swagger-ui-dist` is not on a
    // CDN), so if anything shadowed that mount the page would load as a styled-empty div — a failure
    // mode that looks like a network problem from the browser and is neither.
    const { app } = await docsApp();

    const page = await app.get('/docs/');
    assert.equal(page.status, 200);
    assert.match(page.text, /swagger-ui-bundle\.js/, 'the page references its bundle');

    for (const asset of ['/docs/swagger-ui.css', '/docs/swagger-ui-bundle.js']) {
      const response = await app.get(asset);
      assert.equal(response.status, 200, `${asset} must be served`);
      assert.ok(response.text.length > 1000, `${asset} should be the real file, not a stub`);
    }

    // /docs/oauth2-redirect ships with the UI. It matters here only as the shadowing check: the
    // requirement in §6 is a *bearer* scheme, so nothing should be wiring an OAuth implicit flow, and
    // a catch-all mounted in front of it would silently break the page.
    const redirect = await app.get('/docs/oauth2-redirect.html');
    assert.equal(redirect.status, 200);
    await app.close();
  });

  test('the root endpoint advertises both documentation routes it actually serves', async () => {
    // The endpoint list is what a curious reader navigates from. A list that omits /docs, or lists a
    // route that 404s, is the cheapest possible documentation bug and the most visible one.
    const { app } = await docsApp();
    const root = await app.get('/');

    assert.equal(root.body.docs, '/docs');
    assert.equal(root.body.openapi, '/openapi.json');
    for (const listed of root.body.endpoints) {
      const match = listed.match(/^(GET|POST|PUT|DELETE) (\/[^\s]*)$/);
      if (!match) continue;
      const [, method, path] = match;
      // Only GET routes are probed: a POST-only route (signup, login, logout, reset) legitimately 404s
      // to a GET, and probing it would test Express's router rather than the advertisement.
      if (method !== 'GET') continue;
      if (path.includes('{')) continue; // templated task routes are not probed here
      const probe = await app.get(path);
      // The catch-all turns a genuine miss into a 404 in our own envelope, so a 404 here means the root
      // advertised a route nothing serves.
      assert.notEqual(probe.status, 404, `${listed} is advertised but nothing serves it`);
    }
    await app.close();
  });
});

describe('the OpenAPI document declares the API', () => {
  test('it is a valid-shaped OpenAPI 3 document naming this API and its version', async () => {
    const { app } = await docsApp();
    const doc = await document(app);

    assert.equal(doc.openapi, '3.0.3');
    assert.ok(doc.info.title.length > 0);
    assert.match(doc.info.version, /^\d+\.\d+\.\d+$/);
    assert.ok(Object.keys(doc.paths).length >= 6, 'every required endpoint appears');
    await app.close();
  });

  test('every endpoint §4 requires is present with the right method', async () => {
    const { app } = await docsApp();
    const doc = await document(app);

    // The method is checked because a path key alone proves nothing: `/auth/logout` under `get` would
    // satisfy a `path in doc.paths` assertion and document the wrong contract.
    const required = {
      '/auth/signup': 'post',
      '/auth/login': 'post',
      '/auth/logout': 'post',
      '/public/info': 'get',
      '/protected/profile': 'get',
      '/protected/dashboard': 'get', // §5's optional second protected route
    };
    for (const [path, method] of Object.entries(required)) {
      assert.ok(doc.paths[path], `${path} is missing from the document`);
      assert.ok(doc.paths[path][method], `${path} does not document ${method.toUpperCase()}`);
    }
    await app.close();
  });

  test('the bearer scheme is exactly the HTTP bearer/JWT scheme §6 asks for', async () => {
    const { app } = await docsApp();
    const doc = await document(app);

    const scheme = doc.components.securitySchemes.bearerAuth;
    assert.equal(scheme.type, 'http', 'not apiKey — a scheme that names its header would not be a bearer');
    assert.equal(scheme.scheme, 'bearer');
    assert.equal(scheme.bearerFormat, 'JWT');
    await app.close();
  });

  test('security is attached to exactly the three protected operations and to no others', async () => {
    // The one assertion in this file that a careless edit breaks in the interesting direction: adding
    // `security` to /auth/login would tell every reader they need a token to log in, and dropping it
    // from /auth/logout would document an unauthenticated sign-out.
    const { app } = await docsApp();
    const doc = await document(app);

    const secured = [];
    for (const [path, methods] of Object.entries(doc.paths)) {
      for (const [method, operation] of Object.entries(methods)) {
        if (operation.security) secured.push(`${method.toUpperCase()} ${path}`);
      }
    }

    assert.deepEqual(
      secured.sort(),
      ['GET /protected/dashboard', 'GET /protected/profile', 'POST /auth/logout'].sort(),
      'the operations requiring a bearer token must be exactly the routes the middleware guards',
    );
    await app.close();
  });

  test('every $ref in the document resolves to something it defines', async () => {
    // A dangling $ref renders as an empty box in the UI and nobody notices during a quick look-through.
    const { app } = await docsApp();
    const doc = await document(app);

    const refs = collectRefs(doc);
    assert.ok(refs.length > 0, 'the document is expected to reuse components rather than inline everything');
    for (const ref of refs) {
      assert.notEqual(resolveRef(doc, ref), undefined, `${ref} does not resolve`);
    }
    await app.close();
  });
});

describe('what the document claims about auth matches what the routes do', () => {
  // The point of generating the document in code instead of typing YAML: these comparisons are possible
  // at all. Each one reads the live answer from the same app that serves the docs.

  test('the three operations declared as secured all answer 401 when the bearer is missing', async () => {
    const { app } = await docsApp();
    const doc = await document(app);

    const calls = {
      'GET /protected/profile': () => app.get('/protected/profile'),
      'GET /protected/dashboard': () => app.get('/protected/dashboard'),
      'POST /auth/logout': () => app.post('/auth/logout'),
    };

    for (const [label, call] of Object.entries(calls)) {
      const [method, path] = label.split(' ');
      assert.deepEqual(
        doc.paths[path][method.toLowerCase()].security,
        [{ bearerAuth: [] }],
        `${label} must declare bearerAuth for the next assertion to mean anything`,
      );

      const response = await call();
      assert.equal(response.status, 401, `${label} is documented as protected but does not require a token`);
      assert.deepEqual(response.body, { error: 'Access token required' });
    }
    await app.close();
  });

  test('the operations declared as public really are, and do not 401 with a bad token', async () => {
    const { app } = await docsApp();

    const signup = await app.post('/auth/signup', { email: 'reader@example.com', password: 'correct-horse' });
    assert.notEqual(signup.status, 401, 'a 401 from signup would tell every caller they need to be logged in first');

    const login = await app.post('/auth/login', { email: 'nobody@example.com', password: 'wrong' });
    // Login may 200 or 401 depending on the fake, but either way it must never answer with a
    // WWW-Authenticate: Bearer challenge — that header is the signature of the protected scheme, and
    // a login route that emitted it would document itself as needing a token it is trying to issue.
    assert.notEqual(login.headers.get('www-authenticate'), 'Bearer', 'login does not ask for a bearer token');

    // §4.C in particular: a public route must not become a 401 because a useless token arrived.
    const publicWithJunk = await app.get('/public/info', { authorization: bearer('not-a-token') });
    assert.equal(publicWithJunk.status, 200);
    assert.deepEqual(publicWithJunk.body, { message: 'Welcome stranger! This info is public.' });
    await app.close();
  });

  test('documented response codes for /protected/profile cover what the route answers', async () => {
    const { app } = await docsApp();
    const doc = await document(app);

    const codes = Object.keys(doc.paths['/protected/profile'].get.responses).sort();
    assert.deepEqual(codes, ['200', '401', '502', '503']);

    const ok = await app.get('/protected/profile', { authorization: bearer('fake-access-token') });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.encrypted_password, undefined, 'the documented User schema must stay true');
    await app.close();
  });

  test('the profile response documents exactly the four fields the route returns', async () => {
    // Over-return is the failure this assignment is graded on, and the document is the promise a client
    // builds against. If someone widens publicUser(), the schema and the live body disagree here.
    const { app } = await docsApp();
    const doc = await document(app);

    const documented = Object.keys(doc.components.schemas.User.properties).sort();
    const live = await app.get('/protected/profile', { authorization: bearer('fake-access-token') });
    const returned = Object.keys(live.body).sort();

    assert.deepEqual(documented, ['createdAt', 'email', 'emailConfirmedAt', 'id']);
    assert.deepEqual(returned, documented, 'the document and the route describe the same object');
    await app.close();
  });

  test('nothing in the document or the UI page resembles a key or a token', async () => {
    // The document is public and unauthenticated, so it is exactly where a pasted secret would go
    // global. Asserted structurally: no example value in the whole document is a JWT, and the served
    // page hardcodes no bearer.
    const { app } = await docsApp();
    const doc = await document(app);
    const page = await app.get('/docs/');

    const serialized = JSON.stringify(doc);
    assert.equal(/eyJ[A-Za-z0-9_-]{10,}/.test(serialized), false, 'no JWT-looking example');
    assert.equal(/service_role|SECRET_KEY/.test(serialized), false, 'no secret-key material by name');
    assert.equal(/Bearer\s+eyJ/.test(page.text), false, 'the page itself hardcodes no token');
    await app.close();
  });
});
