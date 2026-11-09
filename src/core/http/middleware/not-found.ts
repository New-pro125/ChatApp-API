import type { RequestHandler } from 'express';
import { NotFoundException } from '@/core/errors/http.error.js';

export class NotFoundMiddleware {
  readonly handle: RequestHandler = (req, _res, next) => {
    next(new NotFoundException(`Route ${req.method} ${req.originalUrl} not found`));
  };
}
