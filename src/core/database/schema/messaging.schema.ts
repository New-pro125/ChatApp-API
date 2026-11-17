import { sql } from 'drizzle-orm';
import {
  check,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from '@/core/database/schema/auth.schema.js';

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
    check('chats_type_check', sql`${table.type} in ('direct', 'group', 'channel')`),
    check(
      'chats_shape_check',
      sql`(${table.type} = 'direct' and ${table.title} is null and ${table.directKey} is not null) or (${table.type} <> 'direct' and ${table.title} is not null and ${table.directKey} is null)`,
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
  },
  (table) => [
    primaryKey({ columns: [table.chatId, table.userId], name: 'chat_members_pkey' }),
    check('chat_members_role_check', sql`${table.role} in ('member', 'admin', 'owner')`),
    index('chat_members_user_id_index').on(table.userId, table.chatId),
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
    replyToMessageId: uuid('reply_to_message_id'),
    forwardedFromChatId: uuid('forwarded_from_chat_id'),
    forwardedFromMessageId: uuid('forwarded_from_message_id'),
    editedAt: timestamp('edited_at', { withTimezone: true }),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.chatId, table.id], name: 'messages_pkey' }),
    check('messages_type_check', sql`${table.type} in ('text', 'system')`),
    check(
      'messages_body_length_check',
      sql`${table.body} is null or char_length(${table.body}) between 1 and 4096`,
    ),
    check('messages_text_body_check', sql`${table.type} <> 'text' or ${table.body} is not null`),
    // Non-unique, so it may omit the partition key. Keeps the `sender_id`
    // RESTRICT foreign key check from scanning all sixteen partitions.
    index('messages_sender_id_index').on(table.senderId),
  ],
);
