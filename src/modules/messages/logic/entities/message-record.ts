export type MessageType = 'text' | 'system' | 'secret';

/**
 * A single message inside a chat.
 *
 * The row is identified by `(chatId, id)`: `messages` is hash partitioned by
 * `chatId`, so a message id is only unique within its chat. Reply and forward
 * targets are stored as ids without foreign keys because the referenced rows
 * may live in another partition or chat. Secret rows carry ciphertext and
 * never a plaintext body.
 */
export class MessageRecord {
  constructor(
    readonly id: string,
    readonly chatId: string,
    readonly senderId: string,
    readonly type: MessageType,
    readonly body: string | null,
    readonly replyToMessageId: string | null,
    readonly forwardedFromChatId: string | null,
    readonly forwardedFromMessageId: string | null,
    readonly editedAt: Date | null,
    readonly deletedAt: Date | null,
    readonly createdAt: Date,
    readonly ciphertext: string | null,
    readonly nonce: string | null,
    readonly ephemeralPublicKey: string | null,
    readonly senderDeviceId: string | null,
    readonly recipientDeviceId: string | null,
  ) {}
}
