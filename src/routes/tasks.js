// The task endpoints from Weeks 2 and 3, ported to Express with their contract intact.
//
// What is deliberately unchanged: the paths, the JSON shape of a task ({id, title, done}), the
// status codes (200 / 201 / 204 / 400 / 404), the single error envelope {"error": "..."}, the
// filtering on GET /tasks, and the 204-carrying-no-body rule.
//
// What is deliberately not copied: the exact wording of Week 3's two 400s that came out of pydantic
// (`invalid path.task_id: Input should be a valid integer, unable to parse string as an integer`).
// There is no pydantic here and the message was never part of the documented contract, so this lane
// says `invalid id: must be a positive integer`. A client that read the status code keeps working;
// a client that string-matched that sentence does not, and is told so in the README rather than
// discovered later.
const express = require('express');

const { HttpError } = require('../errors');
const { asyncHandler, cleanTitle, parseDone, parseId, requireObject } = require('../http');

function createTasksRouter({ tasks }) {
  const router = express.Router();

  router.get(
    '/',
    asyncHandler(async (request, response) => {
      const done = request.query.done === undefined ? undefined : parseDone(request.query.done);
      const search = request.query.search;
      if (search !== undefined && typeof search !== 'string') {
        throw new HttpError(400, 'invalid search: must be a string');
      }
      response.json(await tasks.list({ done, search }));
    }),
  );

  router.get(
    '/:id',
    asyncHandler(async (request, response) => {
      const id = parseId(request.params.id, 'id');
      const task = await tasks.get(id);
      if (!task) throw new HttpError(404, `Task ${id} not found`);
      response.json(task);
    }),
  );

  router.post(
    '/',
    asyncHandler(async (request, response) => {
      const body = requireObject(request.body);
      const task = await tasks.create({
        title: cleanTitle(body.title),
        done: parseDone(body.done) ?? false,
      });
      response.status(201).json(task);
    }),
  );

  router.put(
    '/:id',
    asyncHandler(async (request, response) => {
      const id = parseId(request.params.id, 'id');
      const body = requireObject(request.body);

      const patch = {};
      if ('title' in body) patch.title = cleanTitle(body.title);
      if ('done' in body) patch.done = parseDone(body.done, { required: true });
      if (Object.keys(patch).length === 0) {
        throw new HttpError(400, 'send at least one of title or done');
      }

      const task = await tasks.update(id, patch);
      if (!task) throw new HttpError(404, `Task ${id} not found`);
      response.status(200).json(task);
    }),
  );

  router.delete(
    '/:id',
    asyncHandler(async (request, response) => {
      const id = parseId(request.params.id, 'id');
      if (!(await tasks.remove(id))) throw new HttpError(404, `Task ${id} not found`);
      // 204 with no body. Not `json({})`: a 204 that carries a body is a protocol error, and
      // response.send() in Express still emits Content-Length: 0 for a 204, which is what Week 3's
      // evidence checks for.
      response.status(204).end();
    }),
  );

  return router;
}

module.exports = { createTasksRouter };
