import type { InferSelectModel } from 'drizzle-orm';
import { messagePins } from '@/core/database/schema/index.js';
import type { PinRecord } from '@/modules/messages/logic/ports/message-pin.repository.js';

/** Explicit column selection for the `message_pins` table. */
export const pinSelection = {
  messageId: messagePins.messageId,
  pinnedAt: messagePins.pinnedAt,
  expiresAt: messagePins.expiresAt,
} as const;

export type PinRow = Pick<InferSelectModel<typeof messagePins>, keyof typeof pinSelection>;

export class MessagePinMapper {
  toRecord(row: PinRow): PinRecord {
    return { messageId: row.messageId, pinnedAt: row.pinnedAt, expiresAt: row.expiresAt };
  }
}
