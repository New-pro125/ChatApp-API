/** Per-request receipt context for presenting a page of messages. */
export interface ReadReceiptContext {
  readonly viewerId: string;
  readonly mutual: boolean;
  readonly peerLastReadMessageId: string | null;
  readonly peerLastReadAt: Date | null;
}
