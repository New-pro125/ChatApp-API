import { type RequestHandler, Router } from 'express';
import { inject } from 'inversify';
import { CORE_TYPES } from '@/core/container/core.types.js';
import type { OpenApiRegistry } from '@/core/http/openapi/openapi.registry.js';
import type { OpenApiHttpMethod, RouteContract } from '@/core/http/openapi/openapi.types.js';

/**
 * Registers Express routes and their OpenAPI contracts in one call.
 *
 * Every route must go through this wrapper. A route cannot be added without a
 * contract, and the registry rejects duplicate operation ids or paths at boot.
 */
export class DocumentedRouter {
  readonly router: Router = Router();

  constructor(
    @inject(CORE_TYPES.OpenApiRegistry) private readonly registry: OpenApiRegistry,
    private readonly basePath: string,
  ) {}

  get(path: string, contract: RouteContract, ...handlers: RequestHandler[]): void {
    this.register('get', path, contract, handlers);
  }

  post(path: string, contract: RouteContract, ...handlers: RequestHandler[]): void {
    this.register('post', path, contract, handlers);
  }

  put(path: string, contract: RouteContract, ...handlers: RequestHandler[]): void {
    this.register('put', path, contract, handlers);
  }

  patch(path: string, contract: RouteContract, ...handlers: RequestHandler[]): void {
    this.register('patch', path, contract, handlers);
  }

  delete(path: string, contract: RouteContract, ...handlers: RequestHandler[]): void {
    this.register('delete', path, contract, handlers);
  }

  private register(
    method: OpenApiHttpMethod,
    path: string,
    contract: RouteContract,
    handlers: RequestHandler[],
  ): void {
    this.registry.register({
      method,
      path: this.fullPath(path),
      contract,
    });

    switch (method) {
      case 'get':
        this.router.get(path, ...handlers);
        break;
      case 'post':
        this.router.post(path, ...handlers);
        break;
      case 'put':
        this.router.put(path, ...handlers);
        break;
      case 'patch':
        this.router.patch(path, ...handlers);
        break;
      case 'delete':
        this.router.delete(path, ...handlers);
        break;
    }
  }

  private fullPath(path: string): string {
    const base = this.basePath.endsWith('/') ? this.basePath.slice(0, -1) : this.basePath;

    if (path === '/') {
      return base.length === 0 ? '/' : base;
    }

    return `${base}${path.startsWith('/') ? path : `/${path}`}`;
  }
}
