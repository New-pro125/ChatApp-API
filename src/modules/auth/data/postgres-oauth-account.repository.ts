import { and, eq, sql } from 'drizzle-orm';
import { inject, injectable } from 'inversify';
import { CORE_TYPES } from '@/core/container/core.types.js';
import { PostgresErrorInspector } from '@/core/database/database.error-inspector.js';
import type { AppDatabase } from '@/core/database/database.provider.js';
import { oauthAccounts, users } from '@/core/database/schema/index.js';
import { AppError } from '@/core/errors/app.error.js';
import { PersistenceException } from '@/core/errors/repository.error.js';
import { UserRecordMapper, type UserRow, userSelection } from '@/modules/auth/data/user.mapper.js';
import type { VerifiedOAuthProfile } from '@/modules/auth/logic/entities/oauth-profile.js';
import type { UserRecord } from '@/modules/auth/logic/entities/user-record.js';
import type { OAuthAccountRepository } from '@/modules/auth/logic/ports/oauth-account.repository.js';

/**
 * Resolves a verified OAuth/OIDC profile to a user.
 *
 * Lookup order is provider account, then verified email, then a new verified
 * user. All three steps run inside one transaction so two concurrent logins
 * cannot create duplicate users; a unique violation is resolved by re-reading
 * the account created by the competing transaction.
 */
@injectable()
export class PostgresOAuthAccountRepository implements OAuthAccountRepository {
  private readonly mapper = new UserRecordMapper();
  private readonly errors = new PostgresErrorInspector();

  constructor(@inject(CORE_TYPES.Db) private readonly db: AppDatabase) {}

  async resolve(profile: VerifiedOAuthProfile): Promise<UserRecord> {
    try {
      return await this.resolveInTransaction(profile);
    } catch (error) {
      if (this.errors.isUniqueViolation(error)) {
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

  private resolveInTransaction(profile: VerifiedOAuthProfile): Promise<UserRecord> {
    return this.db.transaction(async (tx) => {
      const existing = await this.findByProviderAccount(profile, tx);

      if (existing) {
        return existing;
      }

      let user = await this.findUserByEmail(profile.email, tx);

      if (!user) {
        user = await this.createUser(profile, tx);
      } else if (user.emailVerifiedAt === null) {
        // The provider has verified this address, so linking the account also
        // confirms the existing password account's email.
        user = await this.markUserVerified(user.id, tx);
      }

      await tx.insert(oauthAccounts).values({
        userId: user.id,
        provider: profile.provider,
        providerAccountId: profile.providerAccountId,
        email: profile.email,
        displayName: profile.displayName,
      });

      return user;
    });
  }

  private async findByProviderAccount(
    profile: VerifiedOAuthProfile,
    db: AppDatabase = this.db,
  ): Promise<UserRecord | null> {
    const rows = await db
      .select(userSelection)
      .from(users)
      .innerJoin(oauthAccounts, eq(oauthAccounts.userId, users.id))
      .where(
        and(
          eq(oauthAccounts.provider, profile.provider),
          eq(oauthAccounts.providerAccountId, profile.providerAccountId),
        ),
      )
      .limit(1);

    const row = rows[0];

    return row ? this.mapper.toRecord(row) : null;
  }

  private async findUserByEmail(email: string, db: AppDatabase): Promise<UserRecord | null> {
    const rows = await db
      .select(userSelection)
      .from(users)
      .where(sql`lower(${users.email}) = lower(${email})`)
      .limit(1);

    const row: UserRow | undefined = rows[0];

    return row ? this.mapper.toRecord(row) : null;
  }

  private async createUser(profile: VerifiedOAuthProfile, db: AppDatabase): Promise<UserRecord> {
    const rows = await db
      .insert(users)
      .values({
        email: profile.email,
        displayName: profile.displayName,
        passwordHash: null,
        emailVerifiedAt: sql`now()`,
      })
      .returning(userSelection);

    const row = rows[0];

    if (!row) {
      throw new PersistenceException('PostgreSQL did not return the created OAuth user');
    }

    return this.mapper.toRecord(row);
  }

  private async markUserVerified(userId: string, db: AppDatabase): Promise<UserRecord> {
    const rows = await db
      .update(users)
      .set({
        emailVerifiedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(eq(users.id, userId))
      .returning(userSelection);

    const row = rows[0];

    if (!row) {
      throw new PersistenceException('PostgreSQL did not return the verified OAuth user');
    }

    return this.mapper.toRecord(row);
  }
}
