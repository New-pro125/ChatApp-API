import { inject, injectable } from 'inversify';
import type { Pool } from 'pg';
import { CORE_TYPES } from '@/core/container/core.types.js';
import { PasswordResetCodeRecord } from '@/modules/auth/logic/entities/password-reset-code.js';
import type {
  CreatePasswordResetCodeInput,
  PasswordResetRepository,
} from '@/modules/auth/logic/ports/password-reset.repository.js';

interface PasswordResetRow {
  id: string;
  user_id: string;
  code_hash: string;
  expires_at: Date;
  attempts: number;
  consumed_at: Date | null;
  reset_token_hash: string | null;
  token_expires_at: Date | null;
  token_used_at: Date | null;
  created_at: Date;
}

const RESET_COLUMNS =
  'id, user_id, code_hash, expires_at, attempts, consumed_at, reset_token_hash, token_expires_at, token_used_at, created_at';

export class PasswordResetRowMapper {
  toRecord(row: PasswordResetRow): PasswordResetCodeRecord {
    return new PasswordResetCodeRecord(
      row.id,
      row.user_id,
      row.code_hash,
      row.expires_at,
      row.attempts,
      row.consumed_at,
      row.reset_token_hash,
      row.token_expires_at,
      row.token_used_at,
      row.created_at,
    );
  }
}

@injectable()
export class PostgresPasswordResetRepository implements PasswordResetRepository {
  private readonly mapper = new PasswordResetRowMapper();

  constructor(@inject(CORE_TYPES.PgPool) private readonly pool: Pool) {}

  async lastCreatedAt(userId: string): Promise<Date | null> {
    const { rows } = await this.pool.query<{ created_at: Date }>(
      `SELECT created_at
       FROM password_reset_codes
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 1`,
      [userId],
    );

    return rows[0]?.created_at ?? null;
  }

  async invalidateActive(userId: string): Promise<void> {
    await this.pool.query(
      `UPDATE password_reset_codes
       SET consumed_at = COALESCE(consumed_at, now()),
           token_used_at = CASE
             WHEN reset_token_hash IS NOT NULL AND token_used_at IS NULL THEN now()
             ELSE token_used_at
           END
       WHERE user_id = $1
         AND (
           consumed_at IS NULL
           OR (reset_token_hash IS NOT NULL AND token_used_at IS NULL)
         )`,
      [userId],
    );
  }

  async create(input: CreatePasswordResetCodeInput): Promise<void> {
    await this.pool.query(
      `INSERT INTO password_reset_codes
         (user_id, code_hash, expires_at, requested_ip)
       VALUES ($1, $2, $3, $4)`,
      [input.userId, input.codeHash, input.expiresAt, input.requestedIp],
    );
  }

  async findActive(userId: string): Promise<PasswordResetCodeRecord | null> {
    const { rows } = await this.pool.query<PasswordResetRow>(
      `SELECT ${RESET_COLUMNS}
       FROM password_reset_codes
       WHERE user_id = $1
         AND consumed_at IS NULL
         AND expires_at > now()
       ORDER BY created_at DESC
       LIMIT 1`,
      [userId],
    );

    const row = rows[0];

    return row ? this.mapper.toRecord(row) : null;
  }

  async incrementAttempts(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE password_reset_codes
       SET attempts = attempts + 1
       WHERE id = $1`,
      [id],
    );
  }

  async markOtpVerified(id: string, tokenHash: string, tokenExpiresAt: Date): Promise<void> {
    await this.pool.query(
      `UPDATE password_reset_codes
       SET consumed_at = now(),
           reset_token_hash = $2,
           token_expires_at = $3
       WHERE id = $1`,
      [id, tokenHash, tokenExpiresAt],
    );
  }

  async findByTokenHash(tokenHash: string): Promise<PasswordResetCodeRecord | null> {
    const { rows } = await this.pool.query<PasswordResetRow>(
      `SELECT ${RESET_COLUMNS}
       FROM password_reset_codes
       WHERE reset_token_hash = $1
       LIMIT 1`,
      [tokenHash],
    );

    const row = rows[0];

    return row ? this.mapper.toRecord(row) : null;
  }

  async markTokenUsed(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE password_reset_codes
       SET token_used_at = now()
       WHERE id = $1`,
      [id],
    );
  }
}
