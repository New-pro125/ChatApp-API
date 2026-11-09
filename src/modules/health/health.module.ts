import type { Router } from 'express';
import type { Container } from 'inversify';
import type { AppModule } from '@/core/modules/app.module.js';
import { HealthContainer } from '@/modules/health/health.container.js';
import { HEALTH_TYPES } from '@/modules/health/health.types.js';
import type { HealthRouter } from '@/modules/health/web/health.router.js';

export class HealthModule implements AppModule {
  readonly name = 'health';
  readonly mountPath = '/health';
  readonly router: Router;

  private readonly container: HealthContainer;

  constructor(root: Container) {
    this.container = new HealthContainer(root);
    this.router = this.container.get<HealthRouter>(HEALTH_TYPES.HealthRouter).router;
  }

  configure(): void {}

  dispose(): Promise<void> {
    this.container.unbindAll();

    return Promise.resolve();
  }
}
