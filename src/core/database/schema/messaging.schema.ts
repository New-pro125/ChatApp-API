import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from '@/core/database/schema/auth.schema.js';
import { mediaObjects } from '@/core/database/schema/media.schema.js';

/**
 * Messaging tables owned by the `messages` module.
 *
 * `chats` is the unified chat identity: direct conversations, groups, and
 * channels all live here and are distinguished by `type`. Participants are
 * modelled by `chat_members`, so a direct chat is simply a chat of type
 * `direct` with exactly two members.
 *
 * IMPORTANT — `messages` is hash partitioned by `chat_id`. Drizzle Kit cannot
 * express `PARTITION BY`, so this file describes the columns, keys, and
 * indexes only; the `PARTITION BY HASH ("chat_id")` clause and the sixteen
 * child partitions are hand-authored in the migration that creates the table.
 * Drizzle Kit still records `messages` in its snapshot as a normal table with
 * the composite primary key below, so future generated column changes emit
 * `ALTER TABLE` statements that PostgreSQL propagates to every partition.
 *
 * Because the primary key is `(chat_id, id)`, a message id is only unique
 * within its chat and every lookup must filter by `chat_id` so the planner can
 * prune partitions. History keysets on `id` (uuidv7, newest-first), which the
 * primary key serves directly. Non-unique indexes may target any column.
 */
export const chats = pgTable(
  'chats',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    type: text('type').notNull(),
    title: text('title'),
    directKey: text('direct_key'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('chats_type_check', sql`${table.type} in ('direct', 'secret', 'group', 'channel')`),
    check(
      'chats_shape_check',
      sql`(${table.type} in ('direct', 'secret') and ${table.title} is null and ${table.directKey} is not null) or (${table.type} not in ('direct', 'secret') and ${table.title} is not null and ${table.directKey} is null)`,
    ),
    check(
      'chats_title_length_check',
      sql`${table.title} is null or char_length(${table.title}) between 1 and 128`,
    ),
    uniqueIndex('chats_direct_key_unique')
      .on(table.directKey)
      .where(sql`${table.directKey} is not null`),
    index('chats_created_by_index').on(table.createdBy),
  ],
);

export const chatMembers = pgTable(
  'chat_members',
  {
    chatId: uuid('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role').notNull().default('member'),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
    leftAt: timestamp('left_at', { withTimezone: true }),
    // Read state is a watermark, not a per-message table. No FK to `messages`:
    // that table is partitioned and hard-deletes must not be restricted.
    lastReadMessageId: uuid('last_read_message_id'),
    lastReadAt: timestamp('last_read_at', { withTimezone: true }),
    selfDestructPreset: text('self_destruct_preset'),
  },
  (table) => [
    primaryKey({ columns: [table.chatId, table.userId], name: 'chat_members_pkey' }),
    check('chat_members_role_check', sql`${table.role} in ('member', 'admin', 'owner')`),
    check(
      'chat_members_self_destruct_preset_check',
      sql`${table.selfDestructPreset} is null or ${table.selfDestructPreset} in ('24h', '7d', '90d')`,
    ),
    index('chat_members_user_id_index').on(table.userId, table.chatId),
  ],
);

/**
 * Per-user bookmarks. There is deliberately no FK to `messages`: that table is
 * hash partitioned and a bookmark must not restrict message deletion. Pins are
 * removed explicitly when a message is soft-deleted, and chat/user deletion
 * cascades from the parent rows.
 */
export const messagePins = pgTable(
  'message_pins',
  {
    chatId: uuid('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    messageId: uuid('message_id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    pinnedAt: timestamp('pinned_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.chatId, table.userId, table.messageId],
      name: 'message_pins_pkey',
    }),
    index('message_pins_chat_user_pinned_at_index').on(
      table.chatId,
      table.userId,
      table.pinnedAt.desc(),
    ),
    index('message_pins_expires_at_index').on(table.expiresAt),
  ],
);

export const messages = pgTable(
  'messages',
  {
    id: uuid('id').notNull().default(sql`uuidv7()`),
    chatId: uuid('chat_id')
      .notNull()
      .references(() => chats.id, { onDelete: 'cascade' }),
    senderId: uuid('sender_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    type: text('type').notNull().default('text'),
    body: text('body'),
    mediaId: uuid('media_id').references(() => mediaObjects.id, { onDelete: 'restrict' }),
    mediaKind: text('media_kind'),
    caption: text('caption'),
    durationMs: integer('duration_ms'),
    width: integer('width'),
    height: integer('height'),
    replyToMessageId: uuid('reply_to_message_id'),
    forwardedFromChatId: uuid('forwarded_from_chat_id'),
    forwardedFromMessageId: uuid('forwarded_from_message_id'),
    editedAt: timestamp('edited_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    ciphertext: text('ciphertext'),
    nonce: text('nonce'),
    ephemeralPublicKey: text('ephemeral_public_key'),
    senderDeviceId: uuid('sender_device_id'),
    recipientDeviceId: uuid('recipient_device_id'),
  },
  (table) => [
    primaryKey({ columns: [table.chatId, table.id], name: 'messages_pkey' }),
    // `messages` is partitioned, so PostgreSQL propagates an added CHECK to
    // every partition. Qualified references such as `"messages"."type"` are
    // invalid inside `messages_p0`; these checks use unqualified identifiers.
    check(
      'messages_type_check',
      sql`${sql.identifier('type')} in ('text', 'system', 'secret', 'media')`,
    ),
    check(
      'messages_body_length_check',
      sql`${table.body} is null or char_length(${table.body}) between 1 and 4096`,
    ),
    // Only live text rows need a body. Scrubbing an expired text message clears
    // its content while keeping the row as a tombstone, so deleted rows are exempt.
    check(
      'messages_text_body_check',
      sql`${sql.identifier('type')} <> 'text' or ${sql.identifier('body')} is not null or ${sql.identifier('deleted_at')} is not null`,
    ),
    check(
      'messages_secret_shape_check',
      sql`${sql.identifier('type')} <> 'secret' or (${sql.identifier('body')} is null and ${sql.identifier('ciphertext')} is not null and ${sql.identifier('nonce')} is not null and ${sql.identifier('ephemeral_public_key')} is not null and ${sql.identifier('sender_device_id')} is not null and ${sql.identifier('recipient_device_id')} is not null)`,
    ),
    check(
      'messages_non_secret_no_ciphertext_check',
      sql`${sql.identifier('type')} = 'secret' or (${sql.identifier('ciphertext')} is null and ${sql.identifier('nonce')} is null and ${sql.identifier('ephemeral_public_key')} is null and ${sql.identifier('sender_device_id')} is null and ${sql.identifier('recipient_device_id')} is null)`,
    ),
    check(
      'messages_secret_no_reply_forward_check',
      sql`${sql.identifier('type')} <> 'secret' or (${sql.identifier('reply_to_message_id')} is null and ${sql.identifier('forwarded_from_chat_id')} is null and ${sql.identifier('forwarded_from_message_id')} is null)`,
    ),
    // Soft deletion clears the media columns to release the FK, so the shape
    // requirement applies to live rows only.
    check(
      'messages_media_shape_check',
      sql`${sql.identifier('type')} <> 'media' or ${sql.identifier('deleted_at')} is not null or (${sql.identifier('media_id')} is not null and ${sql.identifier('media_kind')} in ('image', 'video', 'document', 'voice_note', 'sticker', 'gif') and ${sql.identifier('body')} is null and ${sql.identifier('ciphertext')} is null and ${sql.identifier('nonce')} is null and ${sql.identifier('ephemeral_public_key')} is null and ${sql.identifier('sender_device_id')} is null and ${sql.identifier('recipient_device_id')} is null)`,
    ),
    check(
      'messages_non_media_no_media_check',
      sql`${sql.identifier('type')} = 'media' or (${sql.identifier('media_id')} is null and ${sql.identifier('media_kind')} is null and ${sql.identifier('caption')} is null and ${sql.identifier('duration_ms')} is null and ${sql.identifier('width')} is null and ${sql.identifier('height')} is null)`,
    ),
    check(
      'messages_media_caption_check',
      sql`${sql.identifier('caption')} is null or char_length(${sql.identifier('caption')}) between 1 and 1000`,
    ),
    check(
      'messages_media_duration_check',
      sql`${sql.identifier('duration_ms')} is null or (${sql.identifier('duration_ms')} between 1 and 86400000)`,
    ),
    check(
      'messages_media_width_check',
      sql`${sql.identifier('width')} is null or (${sql.identifier('width')} between 1 and 16384)`,
    ),
    check(
      'messages_media_height_check',
      sql`${sql.identifier('height')} is null or (${sql.identifier('height')} between 1 and 16384)`,
    ),
    // Added checks on a partitioned table must use unqualified identifiers so
    // PostgreSQL can propagate them to every partition.
    check(
      'messages_expires_at_check',
      sql`${sql.identifier('expires_at')} is null or ${sql.identifier('expires_at')} > ${sql.identifier('created_at')}`,
    ),
    // Non-unique, so it may omit the partition key. Keeps the `sender_id`
    // RESTRICT foreign key check from scanning all sixteen partitions.
    index('messages_sender_id_index').on(table.senderId),
    index('messages_expires_at_index').on(table.expiresAt),
    // Non-unique too, so the deliberate live-reference lookup can scan all
    // sixteen partitions without carrying the partition key.
    index('messages_media_id_index').on(table.mediaId),
    index('messages_sender_device_id_index').on(table.chatId, table.senderDeviceId),
    index('messages_recipient_device_id_index').on(table.chatId, table.recipientDeviceId),
  ],
);
