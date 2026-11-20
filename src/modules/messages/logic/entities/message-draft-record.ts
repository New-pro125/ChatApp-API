/** A caller's unsent text draft for one chat. Timestamps are server-owned. */
export class MessageDraftRecord {
  constructor(
    readonly chatId: string,
    readonly userId: string,
    readonly body: string,
    readonly createdAt: Date,
    readonly updatedAt: Date,
  ) {}
}
