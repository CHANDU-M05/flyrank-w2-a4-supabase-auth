// Configuration refuses to start rather than failing later, and it cannot be talked into printing a
// key. Both halves matter: an app that boots with a missing variable answers 500 for every request
// and points at a stack trace, and an app that logs its environment is a credential leak with a
// longer shelf life.
const assert = require('node:assert/strict');
const { describe, test } = require('node:test');

const { ConfigError, describe: describeConfig, keyRole, loadConfig } = require('../src/config');

const WORKING = {
  SUPABASE_URL: 'http://127.0.0.1:54321',
  SUPABASE_KEY: 'sb_publishable_AAAAAAAAAAAAAAAAAAAAAA',
  DATABASE_URL: 'postgresql://postgres:postgres@127.0.0.1:54322/postgres',
  PORT: '3000',
};

// A legacy Supabase API key is a JWT; only the claims matter to this code path, and nothing here
// verifies a signature — it is checking what the operator pasted, not trusting a caller.
function legacyKey(role) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ role, iss: 'supabase' })).toString('base64url');
  return `${header}.${payload}.not-a-real-signature`;
}

describe('environment configuration', () => {
  test('a missing SUPABASE_URL names the variable and where it belongs', () => {
    assert.throws(
      () => loadConfig({ SUPABASE_KEY: 'x' }),
      (error) => {
        assert.ok(error instanceof ConfigError);
        assert.match(error.message, /SUPABASE_URL is not set/);
        assert.match(error.message, /\.env\.example/);
        return true;
      },
    );
  });

  test('a missing SUPABASE_KEY is caught the same way', () => {
    assert.throws(() => loadConfig({ SUPABASE_URL: 'http://x' }), /SUPABASE_KEY is not set/);
  });

  test('a value left as the placeholder from .env.example is not treated as configured', () => {
    assert.throws(
      () => loadConfig({ ...WORKING, SUPABASE_KEY: 'your-anon-or-publishable-key' }),
      /still holds the placeholder/,
    );
    assert.throws(
      () => loadConfig({ ...WORKING, SUPABASE_URL: 'https://your-project.supabase.co' }),
      /still holds the placeholder/,
    );
  });

  test('a whitespace-only value is missing, not empty-but-present', () => {
    assert.throws(() => loadConfig({ ...WORKING, SUPABASE_KEY: '   ' }), /SUPABASE_KEY is not set/);
  });

  test('the sb_secret_ key is refused — that is the privileged key under its current name', () => {
    assert.throws(
      () => loadConfig({ ...WORKING, SUPABASE_KEY: 'sb_secret_BbbBbbBbbBbbBbbBbb' }),
      (error) => {
        assert.match(error.message, /sb_secret_/);
        assert.match(error.message, /Row Level Security/);
        // The refusal must not quote the key it is refusing.
        assert.equal(error.message.includes('BbbBbb'), false);
        return true;
      },
    );
  });

  test('a legacy service_role JWT is refused too', () => {
    assert.throws(
      () => loadConfig({ ...WORKING, SUPABASE_KEY: legacyKey('service_role') }),
      /service_role key/,
    );
  });

  test('a legacy anon JWT is accepted', () => {
    const config = loadConfig({ ...WORKING, SUPABASE_KEY: legacyKey('anon') });

    assert.equal(keyRole(config.supabaseKey), 'anon');
  });

  test('a publishable key is not a JWT, and is still accepted', () => {
    assert.equal(keyRole(WORKING.SUPABASE_KEY), null);
    assert.doesNotThrow(() => loadConfig(WORKING));
  });

  test('PORT must be a usable port number', () => {
    for (const port of ['abc', '0', '70000', '-1']) {
      assert.throws(() => loadConfig({ ...WORKING, PORT: port }), /PORT/, `PORT=${port}`);
    }
    assert.equal(loadConfig({ ...WORKING, PORT: '' }).port, 3000, 'blank falls back to 3000');
    assert.equal(loadConfig(WORKING).port, 3000);
  });

  test('a trailing slash on SUPABASE_URL is removed, so /auth/v1 never becomes //auth/v1', () => {
    const config = loadConfig({ ...WORKING, SUPABASE_URL: 'http://127.0.0.1:54321///' });

    assert.equal(config.supabaseUrl, 'http://127.0.0.1:54321');
  });

  test('DATABASE_URL is optional at load time and null rather than empty', () => {
    const { DATABASE_URL, ...withoutDb } = WORKING;

    assert.equal(loadConfig(withoutDb).databaseUrl, null);
    assert.equal(loadConfig({ ...WORKING, DATABASE_URL: '  ' }).databaseUrl, null);
    assert.equal(loadConfig(WORKING).databaseUrl, DATABASE_URL);
  });
});

describe('what configuration is allowed to say out loud', () => {
  test('describe() reports hosts and ports, and cannot contain a key', () => {
    const config = loadConfig(WORKING);
    const summary = describeConfig(config);

    assert.deepEqual(summary, {
      auth: '127.0.0.1:54321',
      database: '127.0.0.1:54322/postgres',
      port: 3000,
    });
    assert.equal(JSON.stringify(summary).includes(config.supabaseKey), false);
    assert.equal(JSON.stringify(summary).includes('postgres:postgres'), false);
  });

  test('describe() says so when no database is configured', () => {
    const { DATABASE_URL, ...withoutDb } = WORKING;

    assert.equal(describeConfig(loadConfig(withoutDb)).database, 'not configured');
  });

  test('describe() survives a value that is not a URL instead of throwing at startup', () => {
    const summary = describeConfig({
      supabaseUrl: 'not a url',
      supabaseKey: 'sb_publishable_x',
      databaseUrl: 'also not a url',
      port: 3000,
    });

    assert.equal(summary.auth, '<unparsable>');
    assert.equal(summary.database, '<unparsable>');
  });
});
