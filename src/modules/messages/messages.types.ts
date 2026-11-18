export const MESSAGES_TYPES = {
  ChatRepository: Symbol.for('Messages.ChatRepository'),
  ChatMemberRepository: Symbol.for('Messages.ChatMemberRepository'),
  MessageRepository: Symbol.for('Messages.MessageRepository'),

  RequestScope: Symbol.for('Messages.RequestScope'),
  MessagesRateLimiter: Symbol.for('Messages.MessagesRateLimiter'),
  MessagingPolicy: Symbol.for('Messages.MessagingPolicy'),
  ChatService: Symbol.for('Messages.ChatService'),
  MessageService: Symbol.for('Messages.MessageService'),
  ChatController: Symbol.for('Messages.ChatController'),
  MessageController: Symbol.for('Messages.MessageController'),
  MessagesRouter: Symbol.for('Messages.MessagesRouter'),
} as const;
