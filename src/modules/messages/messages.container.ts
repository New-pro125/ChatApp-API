import { Container } from 'inversify';
import { PostgresChatRepository } from '@/modules/messages/data/postgres-chat.repository.js';
import { PostgresChatMemberRepository } from '@/modules/messages/data/postgres-chat-member.repository.js';
import { PostgresMessageRepository } from '@/modules/messages/data/postgres-message.repository.js';
import type { ChatRepository } from '@/modules/messages/logic/ports/chat.repository.js';
import type { ChatMemberRepository } from '@/modules/messages/logic/ports/chat-member.repository.js';
import type { MessageRepository } from '@/modules/messages/logic/ports/message.repository.js';
import { MESSAGES_TYPES } from '@/modules/messages/messages.types.js';

/**
 * Child container for the messaging module.
 *
 * Unit 2.1 binds the data layer only; the module class, router, controllers,
 * and services are added in 2.2 once there are endpoints to serve.
 */
export class MessagesContainer extends Container {
  constructor(parent: Container) {
    super({ parent });

    this.bind<ChatRepository>(MESSAGES_TYPES.ChatRepository)
      .to(PostgresChatRepository)
      .inSingletonScope();
    this.bind<ChatMemberRepository>(MESSAGES_TYPES.ChatMemberRepository)
      .to(PostgresChatMemberRepository)
      .inSingletonScope();
    this.bind<MessageRepository>(MESSAGES_TYPES.MessageRepository)
      .to(PostgresMessageRepository)
      .inSingletonScope();
  }
}
