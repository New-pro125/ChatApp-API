import type { RequestHandler } from 'express';
import { UnauthorizedException } from '@/core/errors/http.error.js';

export class RequireAuthMiddleware {
  readonly handle: RequestHandler = (req, _res, next) => {
    if (!req.isAuthenticated()) {
      next(new UnauthorizedException());
      return;
    }

    next();
  };
}
