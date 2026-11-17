export const MESSAGES_TYPES = {
  ChatRepository: Symbol.for('Messages.ChatRepository'),
  ChatMemberRepository: Symbol.for('Messages.ChatMemberRepository'),
  MessageRepository: Symbol.for('Messages.MessageRepository'),
} as const;
