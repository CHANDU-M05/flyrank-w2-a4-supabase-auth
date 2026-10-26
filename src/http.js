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

module.exports = { asyncHandler, parseId, cleanTitle, parseDone, requireObject, HttpError };
