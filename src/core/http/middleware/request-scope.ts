import type { Request, RequestHandler } from 'express';
import { Container } from 'inversify';
import { CORE_TYPES } from '@/core/container/core.types.js';

export class RequestScopeMiddleware {
  constructor(private readonly parent: Container) {}

  readonly handle: RequestHandler = (req, res, next) => {
    const scope = new Container({ parent: this.parent });

    scope.bind<Request>(CORE_TYPES.HttpRequest).toConstantValue(req);

    req.container = scope;

    res.once('close', () => {
      scope.unbindAll();
    });

    next();
  };
}
