/** A resolved mention of a chat member in a cloud text message. */
export class MessageMentionRecord {
  constructor(
    readonly id: string,
    readonly chatId: string,
    readonly messageId: string,
    readonly mentionedByUserId: string,
    readonly mentionedUserId: string,
    readonly createdAt: Date,
    readonly readAt: Date | null,
    readonly deletedAt: Date | null,
  ) {}
}
