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
    username: text('username'),
    bio: text('bio'),
    phone: text('phone'),
    avatarKey: text('avatar_key'),
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
    uniqueIndex('users_username_lower_unique').on(sql`lower(${table.username})`),
    uniqueIndex('users_phone_unique').on(table.phone),
    check('users_failed_login_attempts_nonnegative', sql`${table.failedLoginAttempts} >= 0`),
    check('users_session_version_positive', sql`${table.sessionVersion} > 0`),
    check(
      'users_username_format',
      sql`${table.username} is null or (${table.username} = lower(${table.username}) and ${table.username} ~ '^[a-z][a-z0-9_]{4,31}$')`,
    ),
    check('users_bio_length', sql`${table.bio} is null or char_length(${table.bio}) <= 70`),
    check(
      'users_phone_format',
      sql`${table.phone} is null or ${table.phone} ~ '^\\+[1-9][0-9]{7,14}$'`,
    ),
    check(
      'users_avatar_key_length',
      sql`${table.avatarKey} is null or char_length(${table.avatarKey}) between 1 and 512`,
    ),
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

/**
 * Rotating refresh tokens: one row per issued token, grouped into families.
 *
 * A family groups the tokens minted from a single login. Presenting a token
 * that was already rotated or revoked is treated as theft: the whole family is
 * revoked and the user must authenticate again.
 */
export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    familyId: uuid('family_id').notNull(),
    tokenHash: text('token_hash').notNull(),
    deviceName: text('device_name'),
    deviceType: text('device_type'),
    clientIp: text('client_ip'),
    userAgent: text('user_agent'),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
    rotatedAt: timestamp('rotated_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedReason: text('revoked_reason'),
    ...timestamps,
  },
  (table) => [
    uniqueIndex('refresh_tokens_token_hash_unique').on(table.tokenHash),
    index('refresh_tokens_user_id_created_at_index').on(table.userId, table.createdAt.desc()),
    index('refresh_tokens_family_id_index').on(table.familyId),
    index('refresh_tokens_active_index')
      .on(table.userId, table.createdAt.desc())
      .where(sql`${table.rotatedAt} is null and ${table.revokedAt} is null`),
    check(
      'refresh_tokens_revocation_consistency',
      sql`${table.revokedAt} is null or ${table.revokedReason} is not null`,
    ),
    // No constraint ties `rotated_at` to `revoked_at`: reuse detection revokes
    // entire families, which legitimately revokes rows that already rotated.
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

/**
 * Per-user privacy preferences.
 *
 * Kept out of `users` because `PrincipalStore` loads that row on every
 * authenticated request; these settings are only read when a feature needs to
 * decide who may see something.
 */
export const userPrivacySettings = pgTable(
  'user_privacy_settings',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    profilePhotoVisibility: text('profile_photo_visibility').notNull().default('everyone'),
    lastSeenVisibility: text('last_seen_visibility').notNull().default('everyone'),
    storiesVisibility: text('stories_visibility').notNull().default('everyone'),
    readReceiptsEnabled: boolean('read_receipts_enabled').notNull().default(true),
    ...timestamps,
  },
  (table) => [
    check(
      'user_privacy_settings_profile_photo_visibility_check',
      sql`${table.profilePhotoVisibility} in ('everyone', 'nobody')`,
    ),
    check(
      'user_privacy_settings_last_seen_visibility_check',
      sql`${table.lastSeenVisibility} in ('everyone', 'nobody')`,
    ),
    check(
      'user_privacy_settings_stories_visibility_check',
      sql`${table.storiesVisibility} in ('everyone', 'nobody')`,
    ),
  ],
);

/**
 * Directional block edges.
 *
 * A row means `blocker` has blocked `blocked`. Mutual effects (messaging,
 * visibility) are enforced by the consuming features; storage stays
 * directional so either side can block independently.
 */
export const userBlocks = pgTable(
  'user_blocks',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    blockerId: uuid('blocker_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    blockedId: uuid('blocked_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('user_blocks_blocker_blocked_unique').on(table.blockerId, table.blockedId),
    index('user_blocks_blocker_created_at_index').on(
      table.blockerId,
      table.createdAt.desc(),
      table.id,
    ),
    index('user_blocks_blocked_id_index').on(table.blockedId),
    check('user_blocks_no_self_block', sql`${table.blockerId} <> ${table.blockedId}`),
  ],
);

export const emailVerificationCodes = pgTable(
  'email_verification_codes',
  {
    id: uuid('id').primaryKey().default(sql`uuidv7()`),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    attempts: integer('attempts').notNull().default(0),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    requestedIp: text('requested_ip'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('email_verification_codes_attempts_nonnegative', sql`${table.attempts} >= 0`),
    // A user may only have one unconsumed code; issuance consumes older rows in
    // the same transaction. This closes the concurrent-resend race.
    uniqueIndex('email_verification_codes_user_id_active_unique')
      .on(table.userId)
      .where(sql`${table.consumedAt} is null`),
    index('email_verification_codes_user_id_created_at_index').on(
      table.userId,
      table.createdAt.desc(),
    ),
  ],
);
