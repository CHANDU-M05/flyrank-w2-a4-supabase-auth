// The tasks table and its three seeds — one definition, shared by the migrator, the seeder and
// the repository, so no two files can disagree about what a task is.
//
// This is the contract the Week 2/3 assignments built, ported to the JavaScript lane unchanged:
// three columns, an id the database generates, and the same three seed titles.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
    id    INTEGER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    title TEXT NOT NULL,
    done  BOOLEAN NOT NULL DEFAULT FALSE
)`;

// RLS is switched on with no policies, which means deny-by-default. That is not decoration: a
// Supabase project exposes `public` tables over PostgREST to anyone holding the anon key, and the
// anon key is published on purpose. With RLS on and no policy, the only way to the rows is through
// this server, which is the arrangement the assignment is actually about.
//
// The server keeps reaching the rows because it connects over `pg` as the table owner, and RLS is
// not applied to the owner by default. That asymmetry is deliberate and is written up in the
// README: the anon key is a public credential, so it must not be able to read the data; the
// trusted server is the thing that decides who does.
const RLS = `ALTER TABLE tasks ENABLE ROW LEVEL SECURITY`;

// The same three tasks the Week 2/3 stack seeds, so a reset leaves every assignment's database
// looking alike. The middle title names this week's dependency instead of Week 2's framework.
const SEED_TASKS = [
  { title: 'Get a server answering on localhost', done: true },
  { title: 'Read the Supabase dashboard', done: false },
  { title: 'Make every error a real status code', done: false },
];

// A connection string rendered without its password, for logs and error messages.
function describeTarget(connectionString) {
  try {
    const url = new URL(connectionString);
    const host = url.hostname || 'localhost';
    const port = url.port || '5432';
    const database = url.pathname.replace(/^\//, '') || '?';
    return `${host}:${port}/${database}`;
  } catch {
    return '<unparsable DATABASE_URL>';
  }
}

module.exports = { SCHEMA, RLS, SEEDS: SEED_TASKS, describeTarget };
