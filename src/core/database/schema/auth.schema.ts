import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

/**
 * Identity and authentication tables.
 *
 * These definitions are the single source of truth for Drizzle Kit. The
 * repositories in `modules/auth/data` import them, map rows to domain records,
 * and never expose Drizzle types outside the data layer.
 */

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
};

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    email: text('email').notNull(),
    displayName: text('display_name').notNull(),
    passwordHash: text('password_hash'),
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
    failedLoginAttempts: integer('failed_login_attempts').notNull().default(0),
    lockedUntil: timestamp('locked_until', { withTimezone: true }),
    lastFailedLoginAt: timestamp('last_failed_login_at', { withTimezone: true }),
    sessionVersion: integer('session_version').notNull().default(1),
    mfaEnabled: boolean('mfa_enabled').notNull().default(false),
    mfaSecretCiphertext: text('mfa_secret_ciphertext'),
    mfaEnrollmentStartedAt: timestamp('mfa_enrollment_started_at', { withTimezone: true }),
    mfaEnrolledAt: timestamp('mfa_enrolled_at', { withTimezone: true }),
    mfaLastTotpStep: bigint('mfa_last_totp_step', { mode: 'number' }),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('users_email_lower_unique').on(sql`lower(${table.email})`),
    check('users_failed_login_attempts_nonnegative', sql`${table.failedLoginAttempts} >= 0`),
    check('users_session_version_positive', sql`${table.sessionVersion} > 0`),
    check(
      'users_mfa_enrollment_consistency',
      sql`not ${table.mfaEnabled} or (${table.mfaSecretCiphertext} is not null and ${table.mfaEnrolledAt} is not null)`,
    ),
    check(
      'users_mfa_last_totp_step_nonnegative',
      sql`${table.mfaLastTotpStep} is null or ${table.mfaLastTotpStep} >= 0`,
    ),
  ],
);

export const oauthAccounts = pgTable(
  'oauth_accounts',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    providerAccountId: text('provider_account_id').notNull(),
    email: text('email'),
    displayName: text('display_name'),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('oauth_accounts_provider_account_unique').on(
      table.provider,
      table.providerAccountId,
    ),
    index('oauth_accounts_user_id_index').on(table.userId),
  ],
);

export const passwordResetCodes = pgTable(
  'password_reset_codes',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    attempts: integer('attempts').notNull().default(0),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    resetTokenHash: text('reset_token_hash'),
    tokenExpiresAt: timestamp('token_expires_at', { withTimezone: true }),
    tokenUsedAt: timestamp('token_used_at', { withTimezone: true }),
    requestedIp: text('requested_ip'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('password_reset_codes_attempts_nonnegative', sql`${table.attempts} >= 0`),
    index('password_reset_codes_user_id_created_at_index').on(table.userId, table.createdAt.desc()),
    uniqueIndex('password_reset_codes_reset_token_hash_unique')
      .on(table.resetTokenHash)
      .where(sql`${table.resetTokenHash} is not null`),
  ],
);

export const mfaChallenges = pgTable(
  'mfa_challenges',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    attempts: integer('attempts').notNull().default(0),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    requestedIp: text('requested_ip'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('mfa_challenges_attempts_nonnegative', sql`${table.attempts} >= 0`),
    uniqueIndex('mfa_challenges_token_hash_unique').on(table.tokenHash),
    index('mfa_challenges_user_id_created_at_index').on(table.userId, table.createdAt.desc()),
  ],
);

export const mfaRecoveryCodes = pgTable(
  'mfa_recovery_codes',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('mfa_recovery_codes_user_id_code_hash_unique').on(table.userId, table.codeHash),
    index('mfa_recovery_codes_user_id_used_at_index').on(table.userId, table.usedAt),
  ],
);
