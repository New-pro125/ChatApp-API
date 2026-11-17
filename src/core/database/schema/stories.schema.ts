import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from '@/core/database/schema/auth.schema.js';

/**
 * Ephemeral stories owned by the stories module.
 *
 * A story carries a text caption, a media object key, or both. Until the media
 * pipeline (Phase 2.4) exists the key is supplied by the client as an opaque
 * reference; 2.4 will replace that with server-generated keys and presigned
 * uploads, so the column shape stays stable. Reads filter on `expires_at`.
 */
export const stories = pgTable(
  'stories',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    caption: text('caption'),
    mediaKey: text('media_key'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check(
      'stories_content_check',
      sql`${table.caption} is not null or ${table.mediaKey} is not null`,
    ),
    check(
      'stories_caption_length_check',
      sql`${table.caption} is null or char_length(${table.caption}) between 1 and 700`,
    ),
    check(
      'stories_media_key_length_check',
      sql`${table.mediaKey} is null or char_length(${table.mediaKey}) between 1 and 512`,
    ),
    index('stories_user_created_at_index').on(table.userId, table.createdAt.desc(), table.id),
    index('stories_expires_at_index').on(table.expiresAt),
  ],
);
