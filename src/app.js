// The Express application, as a function you can build with the things it needs.
//
// createApp() takes its collaborators rather than requiring them at module load, and that is what
// makes the tests in test/ possible: an HTTP test can run the real routing, real validation and real
// error handling against a fake Supabase client and a fake repository, with no network and no
// database. The alternative — a module that builds a global client on import — forces every test to
// either reach the internet or mock `require`, and a test that mocks the framework is not testing
// much.
const express = require('express');
const swaggerUi = require('swagger-ui-express');

const { DatabaseError, HttpError } = require('./errors');
const { createOpenApiDocument } = require('./docs');
const { asyncHandler } = require('./http');
const { createAuthRouter } = require('./routes/auth');
const { createProtectedRouter } = require('./routes/protected');
const { createPublicRouter } = require('./routes/public');
const { createTasksRouter } = require('./routes/tasks');
const { createAuthMiddleware } = require('./middleware/auth');

const API_NAME = 'flyrank-w2-a4-supabase-auth';
// The version tracks what a client can receive, which is the only thing a version is worth naming.
const API_VERSION = '0.1.0';

function createApp({ tasks, supabase = null, signOut = null, log = console.log }) {
  const app = express();

  // Built once and handed to every router that needs it, which is what §5's "do not duplicate
  // token-verification logic" means in practice: one instance, so one set of rules about header
  // shapes, provider outages and what may be attached to the request. Assembling it here rather than
  // inside a route keeps the dependency visible in the wiring.
  const requireAuth = createAuthMiddleware({ supabase });

  // Express's default header advertises the framework and its version to anyone probing the API.
  app.disable('x-powered-by');

  // A body cap, because parsing an unbounded request is a free way to spend the server's memory.
  // Nothing legitimate in this API needs more than a few hundred bytes.
  app.use(express.json({ limit: '16kb' }));

  // Method, path, status, duration. No headers, no bodies: an access token lives in a header, and a
  // log that prints Authorization lines is a log that leaks credentials three months later. The
  // sink is injected so a test run can silence it without silencing real failures.
  app.use((request, response, next) => {
    const startedAt = process.hrtime.bigint();
    response.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
      log(`[http] ${request.method} ${request.originalUrl} ${response.statusCode} ${ms.toFixed(1)}ms`);
    });
    next();
  });

  app.get(
    '/',
    asyncHandler(async (_request, response) => {
      response.json({
        name: API_NAME,
        version: API_VERSION,
        docs: '/docs',
        openapi: '/openapi.json',
        auth: supabase ? 'supabase' : 'not configured',
        store: 'postgres',
        endpoints: [
          'GET /',
          'GET /health',
          'GET /public/info',
          'GET /protected/profile',
          'GET /protected/dashboard',
          'POST /auth/signup',
          'POST /auth/login',
          'POST /auth/logout',
          'GET /tasks',
          'GET /tasks/{id}',
          'POST /tasks',
          'PUT /tasks/{id}',
          'DELETE /tasks/{id}',
          'GET /stats',
          'POST /reset',
          'GET /docs',
          'GET /openapi.json',
        ],
      });
    }),
  );

  app.get(
    '/health',
    asyncHandler(async (_request, response) => {
      // Same rule as Week 3: answer about the dependency, not about the process. A handler that
      // returns ok without asking Postgres only proves the interpreter is running.
      if (!(await tasks.ping())) {
        throw new HttpError(503, 'database unreachable');
      }
      response.json({ status: 'ok' });
    }),
  );

  app.use('/tasks', createTasksRouter({ tasks }));

  app.use('/public', createPublicRouter());
  app.use('/protected', createProtectedRouter({ requireAuth }));

  // Mounted before the catch-all below, so an unmatched path under /auth still reaches it and
  // answers 404 in this API's own envelope.
  app.use('/auth', createAuthRouter({ supabase, requireAuth, signOut }));

  // §6: Swagger UI at /docs with a bearer scheme. The document comes from src/docs.js rather than a
  // hand-maintained YAML file precisely so the test suite can compare it against the live routes —
  // `/openapi.json` exists for the same reason: the assertions are about what the API declares, and
  // that is only checkable if the declaration is reachable as data.
  //
  // The document is built once at wiring time, not per request: it is static, and rebuilding it on
  // every page load of the UI (which polls its own assets) would be pure waste.
  const openApiDocument = createOpenApiDocument({ name: API_NAME, version: API_VERSION });

  app.get('/openapi.json', (_request, response) => response.json(openApiDocument));
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(openApiDocument));

  app.get(
    '/stats',
    asyncHandler(async (_request, response) => {
      response.json(await tasks.stats());
    }),
  );

  // Restarting the process is not a way to get a clean store — that was the point of persisting it —
  // so this is the only route back to the three seeds.
  app.post(
    '/reset',
    asyncHandler(async (_request, response) => {
      response.json({ restored: await tasks.reset() });
    }),
  );

  // Anything unmatched is a 404 in the same envelope as every other error, rather than Express's
  // default HTML page.
  app.use((request, _response, next) => {
    next(new HttpError(404, `${request.method} ${request.originalUrl} not found`));
  });

  // One place that decides what leaves the process. Order and argument count matter: Express only
  // routes errors to a four-argument middleware.
  app.use((error, _request, response, _next) => {
    // body-parser's JSON failure arrives as a SyntaxError with a status already set on it.
    if (error instanceof SyntaxError || error.type === 'entity.parse.failed') {
      return response.status(400).json({ error: 'request body must be valid JSON' });
    }
    // The body cap from express.json(): say 413 in the envelope instead of falling through to 500.
    if (error.type === 'entity.too.large') {
      return response.status(413).json({ error: 'request body is too large' });
    }
    if (error instanceof HttpError) {
      return response.status(error.status).json({ error: error.message });
    }
    if (error instanceof DatabaseError) {
      // Named as a database error but described in our words. The cause stays in the log.
      console.error('[db]', error.cause?.message || error.message);
      return response.status(500).json({ error: `database error: ${error.message}` });
    }

    console.error('[error]', error);
    return response.status(500).json({ error: 'internal server error' });
  });

  return app;
}

module.exports = { createApp, API_NAME, API_VERSION };
