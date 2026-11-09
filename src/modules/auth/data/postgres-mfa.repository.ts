import { inject, injectable } from 'inversify';
import type { Pool, PoolClient } from 'pg';
import { CORE_TYPES } from '@/core/container/core.types.js';
import { PersistenceException } from '@/core/errors/repository.error.js';
import {
  MfaChallengeRecord,
  MfaRecoveryCodeRecord,
} from '@/modules/auth/logic/entities/mfa-record.js';
import type {
  CreateMfaChallengeInput,
  MfaRepository,
} from '@/modules/auth/logic/ports/mfa.repository.js';

interface MfaChallengeRow {
  id: string;
  user_id: string;
  expires_at: Date;
  attempts: number;
  consumed_at: Date | null;
  created_at: Date;
}

interface MfaRecoveryCodeRow {
  id: string;
  user_id: string;
  used_at: Date | null;
  created_at: Date;
}

const CHALLENGE_COLUMNS = 'id, user_id, expires_at, attempts, consumed_at, created_at';
const RECOVERY_CODE_COLUMNS = 'id, user_id, used_at, created_at';

@injectable()
export class PostgresMfaRepository implements MfaRepository {
  constructor(@inject(CORE_TYPES.PgPool) private readonly pool: Pool) {}

  async invalidateChallenges(userId: string): Promise<void> {
    await this.execute('Failed to invalidate MFA challenges', () =>
      this.pool.query(
        `UPDATE mfa_challenges
         SET consumed_at = now()
         WHERE user_id = $1 AND consumed_at IS NULL`,
        [userId],
      ),
    );
  }

  async createChallenge(input: CreateMfaChallengeInput): Promise<void> {
    await this.execute('Failed to create MFA challenge', () =>
      this.pool.query(
        `INSERT INTO mfa_challenges (user_id, token_hash, expires_at, requested_ip)
         VALUES ($1, $2, $3, $4)`,
        [input.userId, input.tokenHash, input.expiresAt, input.requestedIp],
      ),
    );
  }

  findChallengeByTokenHash(tokenHash: string): Promise<MfaChallengeRecord | null> {
    return this.execute('Failed to load MFA challenge', async () => {
      const { rows } = await this.pool.query<MfaChallengeRow>(
        `SELECT ${CHALLENGE_COLUMNS}
         FROM mfa_challenges
         WHERE token_hash = $1
         LIMIT 1`,
        [tokenHash],
      );

      const row = rows[0];

      return row
        ? new MfaChallengeRecord(
            row.id,
            row.user_id,
            row.expires_at,
            row.attempts,
            row.consumed_at,
            row.created_at,
          )
        : null;
    });
  }

  async incrementChallengeAttempts(id: string): Promise<void> {
    await this.execute('Failed to update MFA challenge', () =>
      this.pool.query(
        `UPDATE mfa_challenges
         SET attempts = attempts + 1
         WHERE id = $1`,
        [id],
      ),
    );
  }

  consumeChallenge(id: string): Promise<boolean> {
    return this.execute('Failed to consume MFA challenge', async () => {
      const result = await this.pool.query(
        `UPDATE mfa_challenges
         SET consumed_at = now()
         WHERE id = $1
           AND consumed_at IS NULL
           AND expires_at > now()`,
        [id],
      );

      return (result.rowCount ?? 0) > 0;
    });
  }

  async startEnrollment(userId: string, secretCiphertext: string, startedAt: Date): Promise<void> {
    await this.execute('Failed to start MFA enrollment', () =>
      this.pool.query(
        `UPDATE users
         SET mfa_secret_ciphertext = $2,
             mfa_enrollment_started_at = $3,
             mfa_enabled = false,
             mfa_enrolled_at = NULL,
             mfa_last_totp_step = NULL,
             updated_at = now()
         WHERE id = $1`,
        [userId, secretCiphertext, startedAt],
      ),
    );
  }

  async activate(userId: string, enrolledAt: Date, recoveryCodeHashes: string[]): Promise<void> {
    await this.transaction('Failed to activate MFA', async (client) => {
      await client.query(
        `UPDATE users
         SET mfa_enabled = true,
             mfa_enrolled_at = $2,
             mfa_enrollment_started_at = NULL,
             updated_at = now()
         WHERE id = $1`,
        [userId, enrolledAt],
      );

      await this.replaceRecoveryCodesWith(client, userId, recoveryCodeHashes);
    });
  }

  async disable(userId: string): Promise<void> {
    await this.transaction('Failed to disable MFA', async (client) => {
      await client.query(
        `UPDATE users
         SET mfa_enabled = false,
             mfa_secret_ciphertext = NULL,
             mfa_enrollment_started_at = NULL,
             mfa_enrolled_at = NULL,
             mfa_last_totp_step = NULL,
             updated_at = now()
         WHERE id = $1`,
        [userId],
      );

      await client.query('DELETE FROM mfa_recovery_codes WHERE user_id = $1', [userId]);
    });
  }

  consumeTotpStep(userId: string, step: number): Promise<boolean> {
    return this.execute('Failed to record TOTP step', async () => {
      const result = await this.pool.query(
        `UPDATE users
         SET mfa_last_totp_step = $2,
             updated_at = now()
         WHERE id = $1
           AND (mfa_last_totp_step IS NULL OR mfa_last_totp_step < $2)`,
        [userId, step],
      );

      return (result.rowCount ?? 0) > 0;
    });
  }

  findRecoveryCode(userId: string, codeHash: string): Promise<MfaRecoveryCodeRecord | null> {
    return this.execute('Failed to load MFA recovery code', async () => {
      const { rows } = await this.pool.query<MfaRecoveryCodeRow>(
        `SELECT ${RECOVERY_CODE_COLUMNS}
         FROM mfa_recovery_codes
         WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL
         LIMIT 1`,
        [userId, codeHash],
      );

      const row = rows[0];

      return row
        ? new MfaRecoveryCodeRecord(row.id, row.user_id, row.used_at, row.created_at)
        : null;
    });
  }

  markRecoveryCodeUsed(id: string): Promise<boolean> {
    return this.execute('Failed to consume MFA recovery code', async () => {
      const result = await this.pool.query(
        `UPDATE mfa_recovery_codes
         SET used_at = now()
         WHERE id = $1 AND used_at IS NULL`,
        [id],
      );

      return (result.rowCount ?? 0) > 0;
    });
  }

  countUnusedRecoveryCodes(userId: string): Promise<number> {
    return this.execute('Failed to count MFA recovery codes', async () => {
      const { rows } = await this.pool.query<{ count: number }>(
        `SELECT count(*)::int AS count
         FROM mfa_recovery_codes
         WHERE user_id = $1 AND used_at IS NULL`,
        [userId],
      );

      return rows[0]?.count ?? 0;
    });
  }

  async replaceRecoveryCodes(userId: string, codeHashes: string[]): Promise<void> {
    await this.transaction('Failed to replace MFA recovery codes', (client) =>
      this.replaceRecoveryCodesWith(client, userId, codeHashes),
    );
  }

  private async replaceRecoveryCodesWith(
    client: PoolClient,
    userId: string,
    codeHashes: string[],
  ): Promise<void> {
    await client.query('DELETE FROM mfa_recovery_codes WHERE user_id = $1', [userId]);

    for (const codeHash of codeHashes) {
      await client.query(
        `INSERT INTO mfa_recovery_codes (user_id, code_hash)
         VALUES ($1, $2)`,
        [userId, codeHash],
      );
    }
  }

  private async execute<T>(operation: string, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      throw new PersistenceException(operation, { cause: error });
    }
  }

  private async transaction<T>(
    operation: string,
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');

      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // The connection may already be unusable; preserve the original error.
      }

      throw new PersistenceException(operation, { cause: error });
    } finally {
      client.release();
    }
  }
}
