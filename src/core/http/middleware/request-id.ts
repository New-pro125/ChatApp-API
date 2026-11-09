import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';

export class RequestIdMiddleware {
  private static readonly REQUEST_ID_PATTERN = /^[A-Za-z0-9._-]{1,200}$/;

  readonly handle: RequestHandler = (req, res, next) => {
    const incoming = req.header('x-request-id');

    req.requestId =
      incoming && RequestIdMiddleware.REQUEST_ID_PATTERN.test(incoming) ? incoming : randomUUID();

    res.setHeader('x-request-id', req.requestId);
    next();
  };
}
