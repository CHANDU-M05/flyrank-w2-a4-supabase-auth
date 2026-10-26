// Two error types, because "the client got it wrong" and "the database got it wrong" are different
// answers. Anything else — a driver crash, a bug in a handler — stays unlabelled and is reported as
// a generic 500 by the app's error handler, which is the only place that decides what leaves the
// process. Nothing here is allowed to send a stack trace to a caller.
//
// Every error this app returns goes through the same envelope: { "error": "<message>" }. That is
// the shape Week 2 started with and Week 3 kept, so a client only ever has one thing to parse.

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

class DatabaseError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'DatabaseError';
    // `cause` keeps the original driver error for the log, while the message that reaches the
    // client stays ours: a pg error can contain the SQL text and, through it, request values.
    this.cause = options.cause;
    this.detail = options.detail;
  }
}

module.exports = { HttpError, DatabaseError };
