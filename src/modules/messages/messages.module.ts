import type { Router } from 'express';
import type { Container } from 'inversify';
import type { MessagesRateLimiter } from '@/core/http/middleware/rate-limit.js';
import type { AppModule } from '@/core/modules/app.module.js';
import type { PinCleanupWorker } from '@/modules/messages/logic/pin-cleanup.worker.js';
import type { SelfDestructCleanupWorker } from '@/modules/messages/logic/self-destruct-cleanup.worker.js';
import { MessagesContainer } from '@/modules/messages/messages.container.js';
import { MESSAGES_TYPES } from '@/modules/messages/messages.types.js';
import type { MessagesRouter } from '@/modules/messages/web/routes/messages.router.js';

/** Registers the `/api/chats` router in the application. */
export class MessagesModule implements AppModule {
  readonly name = 'messages';
  readonly mountPath = '/api/chats';
  readonly router: Router;

  private readonly container: MessagesContainer;

  constructor(root: Container) {
    this.container = new MessagesContainer(root);
    this.router = this.container.get<MessagesRouter>(MESSAGES_TYPES.MessagesRouter).router;
  }

  async configure(): Promise<void> {
    this.container.get<MessagesRateLimiter>(MESSAGES_TYPES.MessagesRateLimiter).initialize();
    await this.container.get<PinCleanupWorker>(MESSAGES_TYPES.PinCleanupWorker).start();
    await this.container
      .get<SelfDestructCleanupWorker>(MESSAGES_TYPES.SelfDestructCleanupWorker)
      .start();
  }

  async dispose(): Promise<void> {
    await this.container
      .get<SelfDestructCleanupWorker>(MESSAGES_TYPES.SelfDestructCleanupWorker)
      .close();
    await this.container.get<PinCleanupWorker>(MESSAGES_TYPES.PinCleanupWorker).close();
    this.container.unbindAll();
  }
}
