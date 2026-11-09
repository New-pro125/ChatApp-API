import { inject, injectable } from 'inversify';
import type { Pool } from 'pg';
import { CORE_TYPES } from '@/core/container/core.types.js';
import { PersistenceException, UniqueConstraintException } from '@/core/errors/repository.error.js';
import { UserRecord } from '@/modules/auth/logic/entities/user-record.js';
import type {
  CreateUserInput,
  UserRepository,
} from '@/modules/auth/logic/ports/user.repository.js';

export interface UserRow {
  id: string;
  email: string;
  display_name: string;
  password_hash: string | null;
  email_verified_at: Date | null;
  failed_login_attempts: number;
  locked_until: Date | null;
  last_failed_login_at: Date | null;
  session_version: number;
  mfa_enabled: boolean;
  mfa_secret_ciphertext: string | null;
  mfa_enrollment_started_at: Date | null;
  mfa_enrolled_at: Date | null;
  mfa_last_totp_step: string | null;
  created_at: Date;
}

export class UserRowMapper {
  toRecord(row: UserRow): UserRecord {
    return new UserRecord(
      row.id,
      row.email,
      row.display_name,
      row.password_hash,
      row.email_verified_at,
      row.failed_login_attempts,
      row.locked_until,
      row.last_failed_login_at,
      row.session_version,
      row.mfa_enabled,
      row.mfa_secret_ciphertext,
      row.mfa_enrollment_started_at,
      row.mfa_enrolled_at,
      row.mfa_last_totp_step === null ? null : Number(row.mfa_last_totp_step),
      row.created_at,
    );
  }
}

export const USER_COLUMNS =
  'id, email, display_name, password_hash, email_verified_at, failed_login_attempts, locked_until, last_failed_login_at, session_version, mfa_enabled, mfa_secret_ciphertext, mfa_enrollment_started_at, mfa_enrolled_at, mfa_last_totp_step, created_at';

@injectable()
export class PostgresUserRepository implements UserRepository {
  private readonly mapper = new UserRowMapper();

  constructor(@inject(CORE_TYPES.PgPool) private readonly pool: Pool) {}

  async findById(id: string): Promise<UserRecord | null> {
    const { rows } = await this.pool.query<UserRow>(
      `SELECT ${USER_COLUMNS} FROM users WHERE id = $1`,
      [id],
    );

    const row = rows[0];

    return row ? this.mapper.toRecord(row) : null;
  }

  async findByEmail(email: string): Promise<UserRecord | null> {
    const { rows } = await this.pool.query<UserRow>(
      `SELECT ${USER_COLUMNS} FROM users WHERE lower(email) = lower($1)`,
      [email],
    );

    const row = rows[0];

    return row ? this.mapper.toRecord(row) : null;
  }

  async create(input: CreateUserInput): Promise<UserRecord> {
    try {
      const { rows } = await this.pool.query<UserRow>(
        `INSERT INTO users (email, display_name, password_hash, email_verified_at)
         VALUES ($1, $2, $3, $4)
         RETURNING ${USER_COLUMNS}`,
        [input.email, input.displayName, input.passwordHash, input.emailVerifiedAt ?? null],
      );

      const row = rows[0];

      if (!row) {
        throw new Error('PostgreSQL did not return the created user');
      }

      return this.mapper.toRecord(row);
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        throw new UniqueConstraintException('users_email_lower_unique', { cause: error });
      }

      throw new PersistenceException('Failed to create user', { cause: error });
    }
  }

  async updateLoginFailure(
    id: string,
    attempts: number,
    lastFailedAt: Date,
    lockedUntil: Date | null,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE users
       SET failed_login_attempts = $2,
           last_failed_login_at = $3,
           locked_until = $4,
           updated_at = now()
       WHERE id = $1`,
      [id, attempts, lastFailedAt, lockedUntil],
    );
  }

  async clearLoginFailures(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE users
       SET failed_login_attempts = 0,
           locked_until = NULL,
           last_failed_login_at = NULL,
           updated_at = now()
       WHERE id = $1`,
      [id],
    );
  }

  async updatePassword(id: string, passwordHash: string): Promise<void> {
    await this.pool.query(
      `UPDATE users
       SET password_hash = $2,
           session_version = session_version + 1,
           failed_login_attempts = 0,
           locked_until = NULL,
           last_failed_login_at = NULL,
           updated_at = now()
       WHERE id = $1`,
      [id, passwordHash],
    );
  }

  private isUniqueViolation(error: unknown): error is { code: string } {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === '23505'
    );
  }
}
