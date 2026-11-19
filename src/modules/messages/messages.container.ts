import { Container } from 'inversify';
import { CORE_TYPES } from '@/core/container/core.types.js';
import { MessagesRateLimiter } from '@/core/http/middleware/rate-limit.js';
import { RequestScopeMiddleware } from '@/core/http/middleware/request-scope.js';
import type { MediaReferenceReader } from '@/core/media/media-reference.port.js';
import { PostgresChatRepository } from '@/modules/messages/data/postgres-chat.repository.js';
import { PostgresChatMemberRepository } from '@/modules/messages/data/postgres-chat-member.repository.js';
import { PostgresMessagePinRepository } from '@/modules/messages/data/postgres-message-pin.repository.js';
import { PostgresMessageRepository } from '@/modules/messages/data/postgres-message.repository.js';
import { ChatService } from '@/modules/messages/logic/chat.service.js';
import { MediaKindPolicy } from '@/modules/messages/logic/media-kind.policy.js';
import { MediaReferenceReaderService } from '@/modules/messages/logic/media-reference-reader.service.js';
import { MessageService } from '@/modules/messages/logic/message.service.js';
import { MessagingPolicy } from '@/modules/messages/logic/messaging-policy.service.js';
import type { ChatRepository } from '@/modules/messages/logic/ports/chat.repository.js';
import type { ChatMemberRepository } from '@/modules/messages/logic/ports/chat-member.repository.js';
import type { MessagePinRepository } from '@/modules/messages/logic/ports/message-pin.repository.js';
import type { MessageRepository } from '@/modules/messages/logic/ports/message.repository.js';
import { ReadReceiptService } from '@/modules/messages/logic/read-receipt.service.js';
import { MESSAGES_TYPES } from '@/modules/messages/messages.types.js';
import { ChatController } from '@/modules/messages/web/chat.controller.js';
import { MessageController } from '@/modules/messages/web/message.controller.js';
import { MessagePresenter } from '@/modules/messages/web/message-presenter.service.js';
import { MultipartMediaParser } from '@/modules/messages/web/multipart-media.parser.js';
import { MessagesRouter } from '@/modules/messages/web/routes/messages.router.js';

/** Child container for the messaging module. */
export class MessagesContainer extends Container {
  constructor(private readonly root: Container) {
    super({ parent: root });

    this.bind<RequestScopeMiddleware>(MESSAGES_TYPES.RequestScope).toConstantValue(
      new RequestScopeMiddleware(this),
    );
    this.bind<MessagesRateLimiter>(MESSAGES_TYPES.MessagesRateLimiter)
      .to(MessagesRateLimiter)
      .inSingletonScope();

    this.bind<ChatRepository>(MESSAGES_TYPES.ChatRepository)
      .to(PostgresChatRepository)
      .inSingletonScope();
    this.bind<ChatMemberRepository>(MESSAGES_TYPES.ChatMemberRepository)
      .to(PostgresChatMemberRepository)
      .inSingletonScope();
    this.bind<MessageRepository>(MESSAGES_TYPES.MessageRepository)
      .to(PostgresMessageRepository)
      .inSingletonScope();
    this.bind<MessagePinRepository>(MESSAGES_TYPES.MessagePinRepository)
      .to(PostgresMessagePinRepository)
      .inSingletonScope();

    this.bind<MessagingPolicy>(MESSAGES_TYPES.MessagingPolicy)
      .to(MessagingPolicy)
      .inSingletonScope();
    this.bind<ReadReceiptService>(MESSAGES_TYPES.ReadReceiptService)
      .to(ReadReceiptService)
      .inSingletonScope();
    this.bind<ChatService>(MESSAGES_TYPES.ChatService).to(ChatService).inSingletonScope();
    this.bind<MessageService>(MESSAGES_TYPES.MessageService).to(MessageService).inSingletonScope();
    this.bind<MediaKindPolicy>(MESSAGES_TYPES.MediaKindPolicy)
      .to(MediaKindPolicy)
      .inSingletonScope();
    this.bind<MediaReferenceReaderService>(MESSAGES_TYPES.MediaReferenceReader)
      .to(MediaReferenceReaderService)
      .inSingletonScope();
    this.root
      .bind<MediaReferenceReader>(CORE_TYPES.MediaReferenceReader)
      .toConstantValue(this.get<MediaReferenceReaderService>(MESSAGES_TYPES.MediaReferenceReader));

    this.bind<ChatController>(MESSAGES_TYPES.ChatController).to(ChatController);
    this.bind<MessagePresenter>(MESSAGES_TYPES.MessagePresenter).to(MessagePresenter);
    this.bind<MultipartMediaParser>(MESSAGES_TYPES.MultipartMediaParser)
      .to(MultipartMediaParser)
      .inSingletonScope();
    this.bind<MessageController>(MESSAGES_TYPES.MessageController).to(MessageController);
    this.bind<MessagesRouter>(MESSAGES_TYPES.MessagesRouter).to(MessagesRouter).inSingletonScope();
  }
}
