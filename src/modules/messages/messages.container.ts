import { Container } from 'inversify';
import { CORE_TYPES } from '@/core/container/core.types.js';
import { MessagesRateLimiter } from '@/core/http/middleware/rate-limit.js';
import { RequestScopeMiddleware } from '@/core/http/middleware/request-scope.js';
import type { MediaReferenceReader } from '@/core/media/media-reference.port.js';
import { PostgresChatRepository } from '@/modules/messages/data/postgres-chat.repository.js';
import { PostgresChatMemberRepository } from '@/modules/messages/data/postgres-chat-member.repository.js';
import { PostgresMessageRepository } from '@/modules/messages/data/postgres-message.repository.js';
import { PostgresMessageDraftRepository } from '@/modules/messages/data/postgres-message-draft.repository.js';
import { PostgresMessageMentionRepository } from '@/modules/messages/data/postgres-message-mention.repository.js';
import { PostgresMessagePinRepository } from '@/modules/messages/data/postgres-message-pin.repository.js';
import { ChatService } from '@/modules/messages/logic/chat.service.js';
import { DraftService } from '@/modules/messages/logic/draft.service.js';
import { MediaKindPolicy } from '@/modules/messages/logic/media-kind.policy.js';
import { MediaReferenceReaderService } from '@/modules/messages/logic/media-reference-reader.service.js';
import { MentionService } from '@/modules/messages/logic/mention.service.js';
import { MessageService } from '@/modules/messages/logic/message.service.js';
import { MessagingPolicy } from '@/modules/messages/logic/messaging-policy.service.js';
import { PinService } from '@/modules/messages/logic/pin.service.js';
import { PinCleanupWorker } from '@/modules/messages/logic/pin-cleanup.worker.js';
import type { ChatRepository } from '@/modules/messages/logic/ports/chat.repository.js';
import type { ChatMemberRepository } from '@/modules/messages/logic/ports/chat-member.repository.js';
import type { MessageRepository } from '@/modules/messages/logic/ports/message.repository.js';
import type { MessageDraftRepository } from '@/modules/messages/logic/ports/message-draft.repository.js';
import type { MessageMentionRepository } from '@/modules/messages/logic/ports/message-mention.repository.js';
import type { MessagePinRepository } from '@/modules/messages/logic/ports/message-pin.repository.js';
import { ReadReceiptService } from '@/modules/messages/logic/read-receipt.service.js';
import { SelfDestructCleanupWorker } from '@/modules/messages/logic/self-destruct-cleanup.worker.js';
import { MESSAGES_TYPES } from '@/modules/messages/messages.types.js';
import { ChatController } from '@/modules/messages/web/chat.controller.js';
import { DraftController } from '@/modules/messages/web/draft.controller.js';
import { MessageController } from '@/modules/messages/web/message.controller.js';
import { MessagePresenter } from '@/modules/messages/web/message-presenter.service.js';
import { MultipartMediaParser } from '@/modules/messages/web/multipart-media.parser.js';
import { PinController } from '@/modules/messages/web/pin.controller.js';
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
    this.bind<MessageDraftRepository>(MESSAGES_TYPES.MessageDraftRepository)
      .to(PostgresMessageDraftRepository)
      .inSingletonScope();
    this.bind<MessageMentionRepository>(MESSAGES_TYPES.MessageMentionRepository)
      .to(PostgresMessageMentionRepository)
      .inSingletonScope();

    this.bind<MessagingPolicy>(MESSAGES_TYPES.MessagingPolicy)
      .to(MessagingPolicy)
      .inSingletonScope();
    this.bind<DraftService>(MESSAGES_TYPES.DraftService).to(DraftService).inSingletonScope();
    this.bind<MentionService>(MESSAGES_TYPES.MentionService).to(MentionService).inSingletonScope();
    this.bind<ReadReceiptService>(MESSAGES_TYPES.ReadReceiptService)
      .to(ReadReceiptService)
      .inSingletonScope();
    this.bind<ChatService>(MESSAGES_TYPES.ChatService).to(ChatService).inSingletonScope();
    this.bind<MessageService>(MESSAGES_TYPES.MessageService).to(MessageService).inSingletonScope();
    this.bind<PinService>(MESSAGES_TYPES.PinService).to(PinService).inSingletonScope();
    this.bind<PinCleanupWorker>(MESSAGES_TYPES.PinCleanupWorker)
      .to(PinCleanupWorker)
      .inSingletonScope();
    this.bind<SelfDestructCleanupWorker>(MESSAGES_TYPES.SelfDestructCleanupWorker)
      .to(SelfDestructCleanupWorker)
      .inSingletonScope();
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
    this.bind<DraftController>(MESSAGES_TYPES.DraftController).to(DraftController);
    this.bind<MessagePresenter>(MESSAGES_TYPES.MessagePresenter).to(MessagePresenter);
    this.bind<MultipartMediaParser>(MESSAGES_TYPES.MultipartMediaParser)
      .to(MultipartMediaParser)
      .inSingletonScope();
    this.bind<MessageController>(MESSAGES_TYPES.MessageController).to(MessageController);
    this.bind<PinController>(MESSAGES_TYPES.PinController).to(PinController);
    this.bind<MessagesRouter>(MESSAGES_TYPES.MessagesRouter).to(MessagesRouter).inSingletonScope();
  }
}
