import type { Router } from 'express';
import type { Container } from 'inversify';
import type { AppConfig } from '@/core/config/app.config.js';
import type { AuthRateLimiter } from '@/core/http/middleware/rate-limit.js';
import type { AppModule } from '@/core/modules/app.module.js';
import { AuthContainer } from '@/modules/auth/auth.container.js';
import { AUTH_TYPES } from '@/modules/auth/auth.types.js';
import type { PassportConfigurer } from '@/modules/auth/web/passport/passport.configurer.js';
import type { AuthRouter } from '@/modules/auth/web/routes/auth.router.js';

export class AuthModule implements AppModule {
  readonly name = 'auth';
  readonly mountPath = '/api/auth';
  readonly router: Router;

  private readonly container: AuthContainer;

  constructor(root: Container, config: AppConfig) {
    this.container = new AuthContainer(root, config);
    this.router = this.container.get<AuthRouter>(AUTH_TYPES.AuthRouter).router;
  }

  async configure(): Promise<void> {
    this.container.get<AuthRateLimiter>(AUTH_TYPES.AuthRateLimiter).initialize();

    await this.container.get<PassportConfigurer>(AUTH_TYPES.PassportConfigurer).configure();
  }

  dispose(): Promise<void> {
    this.container.unbindAll();

    return Promise.resolve();
  }
}
