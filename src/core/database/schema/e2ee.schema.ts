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

/** Public device and key material owned by the `e2ee` module. */
export const e2eeDevices = pgTable(
  'e2ee_devices',
  {
    deviceId: uuid('device_id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    signingPublicKey: text('signing_public_key').notNull(),
    identityPublicKey: text('identity_public_key').notNull(),
    identitySignature: text('identity_signature').notNull(),
    signedPrekeyId: integer('signed_prekey_id').notNull(),
    signedPrekeyPublicKey: text('signed_prekey_public_key').notNull(),
    signedPrekeySignature: text('signed_prekey_signature').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    rotatedAt: timestamp('rotated_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('e2ee_devices_user_id_device_id_unique').on(table.userId, table.deviceId),
    check('e2ee_devices_signed_prekey_id_check', sql`${table.signedPrekeyId} > 0`),
    check(
      'e2ee_devices_key_material_check',
      sql`char_length(${table.signingPublicKey}) between 1 and 128 and char_length(${table.identityPublicKey}) between 1 and 128 and char_length(${table.identitySignature}) between 1 and 128 and char_length(${table.signedPrekeyPublicKey}) between 1 and 128 and char_length(${table.signedPrekeySignature}) between 1 and 128`,
    ),
  ],
);

export const e2eePrekeys = pgTable(
  'e2ee_prekeys',
  {
    deviceId: uuid('device_id')
      .notNull()
      .references(() => e2eeDevices.deviceId, { onDelete: 'cascade' }),
    prekeyId: integer('prekey_id').notNull(),
    publicKey: text('public_key').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ columns: [table.deviceId, table.prekeyId], name: 'e2ee_prekeys_pkey' }),
    check('e2ee_prekeys_prekey_id_check', sql`${table.prekeyId} > 0`),
    check('e2ee_prekeys_public_key_check', sql`char_length(${table.publicKey}) between 1 and 128`),
    index('e2ee_prekeys_device_id_index').on(table.deviceId),
  ],
);
