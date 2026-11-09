import type { InferSelectModel } from 'drizzle-orm';
import { users } from '@/core/database/schema/index.js';
import { UserRecord } from '@/modules/auth/logic/entities/user-record.js';

/**
 * Explicit column selection for the `users` table.
 *
 * Repositories must never `SELECT *`; this selection is shared by the user and
 * OAuth repositories so both map identical shapes to `UserRecord`.
 */
export const userSelection = {
  id: users.id,
  email: users.email,
  displayName: users.displayName,
  passwordHash: users.passwordHash,
  emailVerifiedAt: users.emailVerifiedAt,
  failedLoginAttempts: users.failedLoginAttempts,
  lockedUntil: users.lockedUntil,
  lastFailedLoginAt: users.lastFailedLoginAt,
  sessionVersion: users.sessionVersion,
  mfaEnabled: users.mfaEnabled,
  mfaSecretCiphertext: users.mfaSecretCiphertext,
  mfaEnrollmentStartedAt: users.mfaEnrollmentStartedAt,
  mfaEnrolledAt: users.mfaEnrolledAt,
  mfaLastTotpStep: users.mfaLastTotpStep,
  createdAt: users.createdAt,
} as const;

export type UserRow = Pick<InferSelectModel<typeof users>, keyof typeof userSelection>;

export class UserRecordMapper {
  toRecord(row: UserRow): UserRecord {
    return new UserRecord(
      row.id,
      row.email,
      row.displayName,
      row.passwordHash,
      row.emailVerifiedAt,
      row.failedLoginAttempts,
      row.lockedUntil,
      row.lastFailedLoginAt,
      row.sessionVersion,
      row.mfaEnabled,
      row.mfaSecretCiphertext,
      row.mfaEnrollmentStartedAt,
      row.mfaEnrolledAt,
      row.mfaLastTotpStep,
      row.createdAt,
    );
  }
}
