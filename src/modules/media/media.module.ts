import type { Router } from 'express';
import type { Container } from 'inversify';
import type { MediaRateLimiter } from '@/core/http/middleware/rate-limit.js';
import type { AppModule } from '@/core/modules/app.module.js';
import { MediaContainer } from '@/modules/media/media.container.js';
import { MEDIA_TYPES } from '@/modules/media/media.types.js';
import type { MediaRouter } from '@/modules/media/web/routes/media.router.js';

/** Registers the `/api/media` router and exposes the container for test doubles. */
export class MediaModule implements AppModule {
  readonly name = 'media';
  readonly mountPath = '/api/media';
  readonly router: Router;
  readonly mediaContainer: MediaContainer;

  constructor(root: Container) {
    this.mediaContainer = new MediaContainer(root);
    this.router = this.mediaContainer.get<MediaRouter>(MEDIA_TYPES.MediaRouter).router;
  }

  configure(): void {
    this.mediaContainer.get<MediaRateLimiter>(MEDIA_TYPES.MediaRateLimiter).initialize();
  }

  dispose(): Promise<void> {
    this.mediaContainer.unbindAll();

    return Promise.resolve();
  }
}
