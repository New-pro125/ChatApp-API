import { inject, injectable } from 'inversify';
import type { Pool, PoolClient } from 'pg';
import { CORE_TYPES } from '@/core/container/core.types.js';
import { AppError } from '@/core/errors/app.error.js';
import { PersistenceException } from '@/core/errors/repository.error.js';
import {
  USER_COLUMNS,
  type UserRow,
  UserRowMapper,
} from '@/modules/auth/data/postgres-user.repository.js';
import type { VerifiedOAuthProfile } from '@/modules/auth/logic/entities/oauth-profile.js';
import type { UserRecord } from '@/modules/auth/logic/entities/user-record.js';
import type { OAuthAccountRepository } from '@/modules/auth/logic/ports/oauth-account.repository.js';

@injectable()
export class PostgresOAuthAccountRepository implements OAuthAccountRepository {
  private readonly mapper = new UserRowMapper();

  constructor(@inject(CORE_TYPES.PgPool) private readonly pool: Pool) {}

  async resolve(profile: VerifiedOAuthProfile): Promise<UserRecord> {
    try {
      return await this.resolveInTransaction(profile);
    } catch (error) {
      if (this.isUniqueViolation(error)) {
        const existing = await this.findByProviderAccount(profile);
        if (existing) {
          return existing;
        }
      }

      if (error instanceof AppError) {
        throw error;
      }

      throw new PersistenceException('Failed to resolve OAuth account', { cause: error });
    }
  }

  private async resolveInTransaction(profile: VerifiedOAuthProfile): Promise<UserRecord> {
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      const existing = await this.findByProviderAccount(profile, client);

      if (existing) {
        await client.query('COMMIT');
        return existing;
      }

      let user = await this.findUserByEmail(profile.email, client);

      if (!user) {
        user = await this.createUser(profile, client);
      }

      await client.query(
        `INSERT INTO oauth_accounts
           (user_id, provider, provider_account_id, email, display_name)
         VALUES ($1, $2, $3, $4, $5)`,
        [user.id, profile.provider, profile.providerAccountId, profile.email, profile.displayName],
      );

      await client.query('COMMIT');

      return user;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async findByProviderAccount(
    profile: VerifiedOAuthProfile,
    client: Pool | PoolClient = this.pool,
  ): Promise<UserRecord | null> {
    const { rows } = await client.query<UserRow>(
      `SELECT ${USER_COLUMNS}
       FROM users u
       JOIN oauth_accounts a ON a.user_id = u.id
       WHERE a.provider = $1 AND a.provider_account_id = $2`,
      [profile.provider, profile.providerAccountId],
    );

    const row = rows[0];

    return row ? this.mapper.toRecord(row) : null;
  }

  private async findUserByEmail(email: string, client: PoolClient): Promise<UserRecord | null> {
    const { rows } = await client.query<UserRow>(
      `SELECT ${USER_COLUMNS} FROM users WHERE lower(email) = lower($1)`,
      [email],
    );

    const row = rows[0];

    return row ? this.mapper.toRecord(row) : null;
  }

  private async createUser(profile: VerifiedOAuthProfile, client: PoolClient): Promise<UserRecord> {
    const { rows } = await client.query<UserRow>(
      `INSERT INTO users (email, display_name, password_hash, email_verified_at)
       VALUES ($1, $2, NULL, now())
       RETURNING ${USER_COLUMNS}`,
      [profile.email, profile.displayName],
    );

    const row = rows[0];

    if (!row) {
      throw new Error('PostgreSQL did not return the created OAuth user');
    }

    return this.mapper.toRecord(row);
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
