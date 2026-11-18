import type { Router } from 'express';
import type { Container } from 'inversify';
import type { E2eeRateLimiter } from '@/core/http/middleware/rate-limit.js';
import type { AppModule } from '@/core/modules/app.module.js';
import { E2eeContainer } from '@/modules/e2ee/e2ee.container.js';
import { E2EE_TYPES } from '@/modules/e2ee/e2ee.types.js';
import type { E2eeRouter } from '@/modules/e2ee/web/routes/e2ee.router.js';

/** Registers the `/api/e2ee` router in the application. */
export class E2eeModule implements AppModule {
  readonly name = 'e2ee';
  readonly mountPath = '/api/e2ee';
  readonly router: Router;

  private readonly container: E2eeContainer;

  constructor(root: Container) {
    this.container = new E2eeContainer(root);
    this.router = this.container.get<E2eeRouter>(E2EE_TYPES.E2eeRouter).router;
  }

  configure(): void {
    this.container.get<E2eeRateLimiter>(E2EE_TYPES.E2eeRateLimiter).initialize();
  }

  dispose(): Promise<void> {
    this.container.unbindAll();

    return Promise.resolve();
  }
}
