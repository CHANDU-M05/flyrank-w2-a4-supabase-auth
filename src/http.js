// Small HTTP helpers shared by the routers.
//
// `asyncHandler` is not decoration: this is Express 4, which does not catch a rejected promise from
// an async handler. Without it a database outage would leave the request hanging until the client
// gave up, instead of producing the 500 this app promises. Express 5 solved this in the framework;
// the version chosen is the one the rest of the repository already runs, so the wrapper is here.
const { HttpError } = require('./errors');

function asyncHandler(handler) {
  return (request, response, next) => {
    Promise.resolve(handler(request, response, next)).catch(next);
  };
}

// An id that is not a positive integer is a bad request, not a missing resource: `GET /tasks/0`
// and `GET /tasks/-3` can never name a row, and saying 404 would be guessing.
function parseId(raw, name = 'id') {
  if (!/^\d+$/.test(String(raw ?? ''))) {
    throw new HttpError(400, `invalid ${name}: must be a positive integer`);
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new HttpError(400, `invalid ${name}: must be a positive integer`);
  }
  return value;
}

// `title` is required on create and, when present, must be a non-empty string once trimmed. The
// trimmed value is what gets stored, so "   " is not a task and " Buy milk " is the same task as
// "Buy milk".
function cleanTitle(value, { required = true } = {}) {
  if (value === undefined || value === null) {
    if (!required) return undefined;
    throw new HttpError(400, 'title is required');
  }
  if (typeof value !== 'string' || value.trim() === '') {
    throw new HttpError(400, 'title must be a non-empty string');
  }
  return value.trim();
}

function parseDone(value, { required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new HttpError(400, 'done must be true or false');
    return undefined;
  }
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new HttpError(400, 'done must be true or false');
}

// A body must be an object of the right shape before anything reads it. `express.json()` gives
// `{}` when the body is absent, which is why "is this a plain object" has to be asked explicitly:
// arrays and JSON scalars reach handlers too.
function requireObject(body, name = 'request body') {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, `${name} must be a JSON object`);
  }
  return body;
}

// Pull the bearer token out of an Authorization header, or refuse with the 401 §4.D specifies.
//
// This only decides whether a header is *shaped* like a bearer token. It says nothing about whether
// the token means anything — that is `supabase.auth.getUser()`, and it is deliberately not hidden in
// here, because a function named "read the bearer" quietly verifying a signature is how a reviewer
// misses the difference between checking a format and checking an identity.
//
// `Access token required` covers absent, non-Bearer and empty alike. One message for three shapes is
// what §4.D asks for, and it is the right call: distinguishing them hands a caller a free oracle about
// the expected format and buys a legitimate client nothing, since all three mean the same thing —
// there is no usable token in the header.
function readBearer(request) {
  const required = new HttpError(401, 'Access token required');
  const header = request.headers.authorization; // Node lowercases header names, not the value.
  if (typeof header !== 'string') throw required; // Absent, or sent twice and collected into an array.

  // RFC 6750 makes the scheme case-insensitive and lets RFC 7235's optional whitespace be a tab as
  // well as a space, hence one split on any run of whitespace rather than a hard-coded ' '. Anything
  // that splits into more than scheme-and-token is two things jammed into one header, and gets
  // refused rather than guessed at.
  const parts = header.trim().split(/\s+/);
  if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer' || parts[1] === '') throw required;

  return parts[1];
}

module.exports = { asyncHandler, parseId, cleanTitle, parseDone, requireObject, readBearer, HttpError };
