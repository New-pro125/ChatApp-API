import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { users } from '@/core/database/schema/auth.schema.js';

/**
 * Generic media objects owned by the media module.
 *
 * A row is created with `pending` status before the client uploads bytes. Only
 * finalize may move it to `ready` or `quarantined`; `failed` is reserved for
 * unrecoverable metadata/storage errors. Drizzle types never leave the data
 * layer — repositories map rows to `MediaObjectRecord`.
 */
export const mediaObjects = pgTable(
  'media_objects',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    ownerUserId: uuid('owner_user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    objectKey: text('object_key').notNull(),
    contentType: text('content_type').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    sha256: text('sha256'),
    status: text('status').notNull().default('pending'),
    scanSignature: text('scan_signature'),
    scanError: text('scan_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    finalizedAt: timestamp('finalized_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('media_objects_object_key_unique').on(table.objectKey),
    index('media_objects_owner_status_index').on(table.ownerUserId, table.status),
    index('media_objects_owner_created_at_index').on(
      table.ownerUserId,
      table.createdAt.desc(),
      table.id,
    ),
    check(
      'media_objects_status_check',
      sql`${table.status} in ('pending', 'ready', 'quarantined', 'failed')`,
    ),
    check(
      'media_objects_object_key_length_check',
      sql`char_length(${table.objectKey}) between 1 and 512`,
    ),
    check(
      'media_objects_content_type_length_check',
      sql`char_length(${table.contentType}) between 1 and 128`,
    ),
    check('media_objects_size_bytes_check', sql`${table.sizeBytes} > 0`),
    check(
      'media_objects_sha256_check',
      sql`${table.sha256} is null or ${table.sha256} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'media_objects_scan_signature_length_check',
      sql`${table.scanSignature} is null or char_length(${table.scanSignature}) between 1 and 512`,
    ),
    check(
      'media_objects_scan_error_length_check',
      sql`${table.scanError} is null or char_length(${table.scanError}) between 1 and 512`,
    ),
  ],
);
