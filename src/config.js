// Configuration: one place that turns the environment into a validated object.
//
// Two rules this file exists to enforce:
//
//   1. A missing variable must say which one and where it should have come from. An Express app
//      that starts and then throws `undefined is not a function` three requests in is worse than
//      one that refuses to start.
//   2. Nothing in here may put a secret into a message or a log line. `describe()` is the only
//      way anything leaves this module for display purposes, and it deliberately cannot reach the
//      key.
const path = require('node:path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const PLACEHOLDERS = new Set([
  'your-anon-or-publishable-key',
  'https://your-project.supabase.co',
  'your-project-ref',
]);

class ConfigError extends Error {}

// Reads the `role` claim out of a legacy Supabase API key, which is a JWT. Returns null for the
// newer `sb_publishable_…` / `sb_secret_…` format, which is opaque. This is NOT an authorisation
// decision — nothing here trusts the token, and an attacker who forged a key claiming role=anon
// would only be allowed to do what an anon key can already do. The point runs the other way: stop
// the operator from wiring a privileged key into an app that is meant to hold only a public one.
function keyRole(maybeJwt) {
  const segments = String(maybeJwt).split('.');
  if (segments.length !== 3) return null;
  try {
    const claims = JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8'));
    return typeof claims.role === 'string' ? claims.role : null;
  } catch {
    return null;
  }
}

function required(env, name) {
  const value = (env[name] || '').trim();
  if (!value) {
    throw new ConfigError(
      `${name} is not set. Copy .env.example to .env and fill it in, or export ${name} ` +
        'in the environment before starting the server.',
    );
  }
  if (PLACEHOLDERS.has(value)) {
    throw new ConfigError(
      `${name} still holds the placeholder from .env.example. Replace it with the value for your ` +
        'Supabase project (Dashboard -> Project Settings -> API).',
    );
  }
  return value;
}

function loadConfig(env = process.env) {
  const supabaseUrl = required(env, 'SUPABASE_URL').replace(/\/+$/, '');
  const supabaseKey = required(env, 'SUPABASE_KEY');

  // §2 of the brief: never use or expose the service_role key. Enforced rather than advised, in
  // both key formats. Supabase renamed the privileged key: the CLI in this repository's pinned
  // version prints `sb_publishable_…` and `sb_secret_…`, where older projects and most tutorials
  // say `anon` and `service_role`. Both ways of holding a server-side key are refused here.
  if (supabaseKey.startsWith('sb_secret_')) {
    throw new ConfigError(
      'SUPABASE_KEY is an sb_secret_… key — the current name for the privileged (service_role) key, '
        + 'which bypasses Row Level Security. It must not be given to this server. Use the '
        + 'sb_publishable_… key.',
    );
  }
  if (keyRole(supabaseKey) === 'service_role') {
    throw new ConfigError(
      'SUPABASE_KEY is a service_role key. It bypasses Row Level Security for every request this '
        + 'server makes, so it is refused here. Use the anon/public key — the one whose JWT has '
        + '"role": "anon".',
    );
  }

  const port = Number.parseInt(env.PORT || '3000', 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`PORT must be a number between 1 and 65535, got: ${env.PORT}`);
  }

  return {
    port,
    supabaseUrl,
    supabaseKey,
    // The task CRUD from Weeks 2/3 keeps its own connection: the app is a server, so it talks to
    // Postgres directly rather than through PostgREST. Optional at load time because the auth part
    // of the assignment does not need it; the CRUD asks for it when it is built.
    databaseUrl: (env.DATABASE_URL || '').trim() || null,
  };
}

// A printable summary that is safe to put in a terminal and in evidence files: host and port only,
// never the key.
function describe(config) {
  const target = (url) => {
    try {
      const parsed = new URL(url);
      return `${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}`;
    } catch {
      return '<unparsable>';
    }
  };
  return {
    auth: target(config.supabaseUrl),
    database: config.databaseUrl ? target(config.databaseUrl) : 'not configured',
    port: config.port,
  };
}

module.exports = { loadConfig, describe, keyRole, ConfigError };
