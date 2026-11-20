import type { Router } from 'express';
import { inject, injectable } from 'inversify';
import type { RequireBearerAuthMiddleware } from '@/core/auth/require-bearer-auth.middleware.js';
import type { RequireVerifiedEmailMiddleware } from '@/core/auth/require-verified-email.middleware.js';
import { CORE_TYPES } from '@/core/container/core.types.js';
import type { MessagesRateLimiter } from '@/core/http/middleware/rate-limit.js';
import type { RequestScopeMiddleware } from '@/core/http/middleware/request-scope.js';
import { DocumentedRouter } from '@/core/http/openapi/documented-router.js';
import type { OpenApiRegistry } from '@/core/http/openapi/openapi.registry.js';
import { MESSAGES_TYPES } from '@/modules/messages/messages.types.js';
import type { ChatController } from '@/modules/messages/web/chat.controller.js';
import { messageContracts } from '@/modules/messages/web/dto/message.openapi.js';
import type { MessageController } from '@/modules/messages/web/message.controller.js';
import type { PinController } from '@/modules/messages/web/pin.controller.js';

/** HTTP routes for chats and their nested messages. */
@injectable()
export class MessagesRouter {
  readonly router: Router;

  constructor(
    @inject(MESSAGES_TYPES.RequestScope) scope: RequestScopeMiddleware,
    @inject(MESSAGES_TYPES.MessagesRateLimiter) private readonly limiter: MessagesRateLimiter,
    @inject(CORE_TYPES.OpenApiRegistry) registry: OpenApiRegistry,
    @inject(CORE_TYPES.RequireAuth) private readonly requireAuth: RequireBearerAuthMiddleware,
    @inject(CORE_TYPES.RequireVerifiedEmail)
    private readonly requireVerifiedEmail: RequireVerifiedEmailMiddleware,
  ) {
    const routes = new DocumentedRouter(registry, '/api/chats');
    this.router = routes.router;
    this.router.use(scope.handle);

    routes.post(
      '/',
      messageContracts.openDirect,
      this.requireAuth.handle,
      this.requireVerifiedEmail.handle,
      this.limiter.handle,
      (req, res, next) =>
        req.container.get<ChatController>(MESSAGES_TYPES.ChatController).openDirect(req, res, next),
    );

    routes.get(
      '/',
      messageContracts.listChats,
      this.requireAuth.handle,
      this.requireVerifiedEmail.handle,
      (req, res, next) =>
        req.container.get<ChatController>(MESSAGES_TYPES.ChatController).listMine(req, res, next),
    );

    routes.post(
      '/secret',
      messageContracts.openSecret,
      this.requireAuth.handle,
      this.requireVerifiedEmail.handle,
      this.limiter.handle,
      (req, res, next) =>
        req.container.get<ChatController>(MESSAGES_TYPES.ChatController).openSecret(req, res, next),
    );

    routes.post(
      '/:chatId/read',
      messageContracts.markRead,
      this.requireAuth.handle,
      this.requireVerifiedEmail.handle,
      this.limiter.handle,
      (req, res, next) =>
        req.container.get<ChatController>(MESSAGES_TYPES.ChatController).markRead(req, res, next),
    );

    routes.patch(
      '/:chatId/self-destruct',
      messageContracts.setSelfDestruct,
      this.requireAuth.handle,
      this.requireVerifiedEmail.handle,
      this.limiter.handle,
      (req, res, next) =>
        req.container
          .get<ChatController>(MESSAGES_TYPES.ChatController)
          .setSelfDestruct(req, res, next),
    );

    routes.post(
      '/:chatId/messages/:messageId/pin',
      messageContracts.pinMessage,
      this.requireAuth.handle,
      this.requireVerifiedEmail.handle,
      this.limiter.handle,
      (req, res, next) =>
        req.container.get<PinController>(MESSAGES_TYPES.PinController).pin(req, res, next),
    );

    routes.delete(
      '/:chatId/messages/:messageId/pin',
      messageContracts.unpinMessage,
      this.requireAuth.handle,
      this.requireVerifiedEmail.handle,
      this.limiter.handle,
      (req, res, next) =>
        req.container.get<PinController>(MESSAGES_TYPES.PinController).unpin(req, res, next),
    );

    routes.get(
      '/:chatId/pins',
      messageContracts.listPinned,
      this.requireAuth.handle,
      this.requireVerifiedEmail.handle,
      (req, res, next) =>
        req.container.get<PinController>(MESSAGES_TYPES.PinController).list(req, res, next),
    );

    routes.post(
      '/:chatId/secret-messages',
      messageContracts.sendSecretMessage,
      this.requireAuth.handle,
      this.requireVerifiedEmail.handle,
      this.limiter.handle,
      (req, res, next) =>
        req.container
          .get<MessageController>(MESSAGES_TYPES.MessageController)
          .sendSecret(req, res, next),
    );

    routes.post(
      '/:chatId/messages',
      messageContracts.sendMessage,
      this.requireAuth.handle,
      this.requireVerifiedEmail.handle,
      this.limiter.handle,
      (req, res, next) =>
        req.container.get<MessageController>(MESSAGES_TYPES.MessageController).send(req, res, next),
    );

    routes.post(
      '/:chatId/messages/media',
      messageContracts.sendMedia,
      this.requireAuth.handle,
      this.requireVerifiedEmail.handle,
      this.limiter.handle,
      (req, res, next) =>
        req.container
          .get<MessageController>(MESSAGES_TYPES.MessageController)
          .sendMedia(req, res, next),
    );

    routes.post(
      '/:chatId/messages/media/upload',
      messageContracts.uploadMedia,
      this.requireAuth.handle,
      this.requireVerifiedEmail.handle,
      this.limiter.handle,
      (req, res, next) =>
        req.container
          .get<MessageController>(MESSAGES_TYPES.MessageController)
          .uploadMedia(req, res, next),
    );

    routes.get(
      '/:chatId/messages',
      messageContracts.listMessages,
      this.requireAuth.handle,
      this.requireVerifiedEmail.handle,
      (req, res, next) =>
        req.container.get<MessageController>(MESSAGES_TYPES.MessageController).list(req, res, next),
    );

    routes.patch(
      '/:chatId/messages/:messageId',
      messageContracts.editMessage,
      this.requireAuth.handle,
      this.requireVerifiedEmail.handle,
      this.limiter.handle,
      (req, res, next) =>
        req.container.get<MessageController>(MESSAGES_TYPES.MessageController).edit(req, res, next),
    );

    routes.delete(
      '/:chatId/messages/:messageId',
      messageContracts.deleteMessage,
      this.requireAuth.handle,
      this.requireVerifiedEmail.handle,
      this.limiter.handle,
      (req, res, next) =>
        req.container
          .get<MessageController>(MESSAGES_TYPES.MessageController)
          .remove(req, res, next),
    );

    routes.post(
      '/:chatId/messages/:messageId/forward',
      messageContracts.forwardMessage,
      this.requireAuth.handle,
      this.requireVerifiedEmail.handle,
      this.limiter.handle,
      (req, res, next) =>
        req.container
          .get<MessageController>(MESSAGES_TYPES.MessageController)
          .forward(req, res, next),
    );
  }
}
