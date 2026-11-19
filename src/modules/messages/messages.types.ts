export const MESSAGES_TYPES = {
  ChatRepository: Symbol.for('Messages.ChatRepository'),
  ChatMemberRepository: Symbol.for('Messages.ChatMemberRepository'),
  MessageRepository: Symbol.for('Messages.MessageRepository'),

  RequestScope: Symbol.for('Messages.RequestScope'),
  MessagesRateLimiter: Symbol.for('Messages.MessagesRateLimiter'),
  MessagingPolicy: Symbol.for('Messages.MessagingPolicy'),
  ReadReceiptService: Symbol.for('Messages.ReadReceiptService'),
  ChatService: Symbol.for('Messages.ChatService'),
  MessageService: Symbol.for('Messages.MessageService'),
  MediaKindPolicy: Symbol.for('Messages.MediaKindPolicy'),
  MediaReferenceReader: Symbol.for('Messages.MediaReferenceReader'),
  ChatController: Symbol.for('Messages.ChatController'),
  MessagePresenter: Symbol.for('Messages.MessagePresenter'),
  MultipartMediaParser: Symbol.for('Messages.MultipartMediaParser'),
  MessageController: Symbol.for('Messages.MessageController'),
  MessagesRouter: Symbol.for('Messages.MessagesRouter'),
} as const;
