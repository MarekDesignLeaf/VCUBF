import type { NextFunction, Request, RequestHandler, Response } from "express";

/**
 * Lets an async route fail without taking the process down.
 *
 * Express 4 does not forward a rejected promise from an async handler to the
 * error middleware: the rejection is unhandled, and Node ends the process. One
 * query against a missing table is enough to stop the whole server, which is a
 * disproportionate outcome for a single bad request.
 *
 * Wrapping the handler sends the failure to the error handler instead, which
 * answers 500 and carries on serving everything else.
 */
export function asyncRoute(
  handler: (req: Request, res: Response, next: NextFunction) => unknown,
): RequestHandler {
  return (req, res, next) => {
    void Promise.resolve(handler(req, res, next)).catch(next);
  };
}
