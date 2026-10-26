// Boot the real Express app on an ephemeral port and talk to it over HTTP with Node's own fetch.
//
// Why not call the handlers directly: because the things worth testing live in the plumbing — the
// order middleware runs in, which error handler catches what, whether a 204 really carries no body,
// whether Express's default 404 page escapes. None of that is visible from a unit call on a handler,
// and it costs less to run a real socket here than to add supertest as a dependency.
const { createApp } = require('../../src/app');

async function startTestApp({ tasks, supabase = null, extra = null }) {
  const app = createApp({ tasks, supabase, log: () => {} });
  if (extra) extra(app);

  const server = await new Promise((resolve, reject) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    instance.on('error', reject);
  });

  const base = `http://127.0.0.1:${server.address().port}`;

  async function call(method, path, options = {}) {
    const headers = { ...options.headers };
    const init = { method, headers };

    if (options.authorization !== undefined) headers.authorization = options.authorization;
    if (options.body !== undefined) {
      init.body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
      if (!headers['content-type']) headers['content-type'] = 'application/json';
    }

    const response = await fetch(`${base}${path}`, init);
    const text = await response.text();

    let body = null;
    if (text !== '') {
      try {
        body = JSON.parse(text);
      } catch {
        body = null; // A non-JSON answer is itself worth asserting on; `text` is returned too.
      }
    }

    return { status: response.status, headers: response.headers, text, body };
  }

  const get = (path, options) => call('GET', path, options);
  const post = (path, body, options) => call('POST', path, { ...options, body });
  const put = (path, body, options) => call('PUT', path, { ...options, body });
  const del = (path, options) => call('DELETE', path, options);

  async function close() {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }

  return { base, call, get, post, put, del, close, server };
}

// An Authorization header value, spelled once so a test that means to send a bearer token cannot
// accidentally test something else.
const bearer = (token) => `Bearer ${token}`;

module.exports = { startTestApp, bearer };
