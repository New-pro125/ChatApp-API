import { eq, inArray, sql } from 'drizzle-orm';
import { inject, injectable } from 'inversify';
import { CORE_TYPES } from '@/core/container/core.types.js';
import { PostgresErrorInspector } from '@/core/database/database.error-inspector.js';
import type { AppDatabase } from '@/core/database/database.provider.js';
import { users } from '@/core/database/schema/index.js';
import { PersistenceException, UniqueConstraintException } from '@/core/errors/repository.error.js';
import type { UserSummary } from '@/core/users/user-summary.reader.js';
import { UserRecordMapper, userSelection } from '@/modules/auth/data/user.mapper.js';
import type { UserRecord } from '@/modules/auth/logic/entities/user-record.js';
import type {
  CreateUserInput,
  UpdateProfileInput,
  UserRepository,
} from '@/modules/auth/logic/ports/user.repository.js';

/**
 * Reads and writes the identity row.
 *
 * Row mapping is centralized in `UserRecordMapper`; Drizzle types never leave
 * this data layer.
 */
@injectable()
export class PostgresUserRepository implements UserRepository {
  private readonly mapper = new UserRecordMapper();
  private readonly errors = new PostgresErrorInspector();

  constructor(@inject(CORE_TYPES.Db) private readonly db: AppDatabase) {}

  async findById(id: string): Promise<UserRecord | null> {
    const rows = await this.db.select(userSelection).from(users).where(eq(users.id, id)).limit(1);

    const row = rows[0];

    return row ? this.mapper.toRecord(row) : null;
  }

  findSummaries(userIds: readonly string[]): Promise<UserSummary[]> {
    if (userIds.length === 0) {
      return Promise.resolve([]);
    }

    return this.db
      .select({
        id: users.id,
        username: users.username,
        displayName: users.displayName,
        avatarKey: users.avatarKey,
      })
      .from(users)
      .where(inArray(users.id, [...userIds]));
  }

  async findByEmail(email: string): Promise<UserRecord | null> {
    const rows = await this.db
      .select(userSelection)
      .from(users)
      .where(sql`lower(${users.email}) = lower(${email})`)
      .limit(1);

    const row = rows[0];

    return row ? this.mapper.toRecord(row) : null;
  }

  async create(input: CreateUserInput): Promise<UserRecord> {
    try {
      const rows = await this.db
        .insert(users)
        .values({
          email: input.email,
          displayName: input.displayName,
          passwordHash: input.passwordHash,
          emailVerifiedAt: input.emailVerifiedAt ?? null,
        })
        .returning(userSelection);

      const row = rows[0];

      if (!row) {
        throw new PersistenceException('PostgreSQL did not return the created user');
      }

      return this.mapper.toRecord(row);
    } catch (error) {
      if (this.errors.isUniqueViolation(error)) {
        throw new UniqueConstraintException(
          this.errors.constraintName(error) ?? 'users_email_lower_unique',
          { cause: error },
        );
      }

      throw new PersistenceException('Failed to create user', { cause: error });
    }
  }

  async updateProfile(id: string, input: UpdateProfileInput): Promise<UserRecord | null> {
    const values: {
      displayName?: string;
      username?: string | null;
      bio?: string | null;
      phone?: string | null;
      updatedAt: Date;
    } = { updatedAt: new Date() };

    if (input.displayName !== undefined) {
      values.displayName = input.displayName;
    }

    if (input.username !== undefined) {
      values.username = input.username;
    }

    if (input.bio !== undefined) {
      values.bio = input.bio;
    }

    if (input.phone !== undefined) {
      values.phone = input.phone;
    }

    try {
      const rows = await this.db
        .update(users)
        .set(values)
        .where(eq(users.id, id))
        .returning(userSelection);

      const row = rows[0];

      return row ? this.mapper.toRecord(row) : null;
    } catch (error) {
      if (this.errors.isUniqueViolation(error)) {
        throw new UniqueConstraintException(
          this.errors.constraintName(error) ?? 'users_username_lower_unique',
          { cause: error },
        );
      }

      throw new PersistenceException('Failed to update user profile', { cause: error });
    }
  }

  async updateLoginFailure(
    id: string,
    attempts: number,
    lastFailedAt: Date,
    lockedUntil: Date | null,
  ): Promise<void> {
    await this.db
      .update(users)
      .set({
        failedLoginAttempts: attempts,
        lastFailedLoginAt: lastFailedAt,
        lockedUntil,
        updatedAt: sql`now()`,
      })
      .where(eq(users.id, id));
  }

  async clearLoginFailures(id: string): Promise<void> {
    await this.db
      .update(users)
      .set({
        failedLoginAttempts: 0,
        lockedUntil: null,
        lastFailedLoginAt: null,
        updatedAt: sql`now()`,
      })
      .where(eq(users.id, id));
  }

  async updatePassword(id: string, passwordHash: string): Promise<void> {
    await this.db
      .update(users)
      .set({
        passwordHash,
        sessionVersion: sql`${users.sessionVersion} + 1`,
        failedLoginAttempts: 0,
        lockedUntil: null,
        lastFailedLoginAt: null,
        updatedAt: sql`now()`,
      })
      .where(eq(users.id, id));
  }

  async markEmailVerified(id: string, verifiedAt: Date): Promise<void> {
    await this.db
      .update(users)
      .set({
        emailVerifiedAt: verifiedAt,
        updatedAt: sql`now()`,
      })
      .where(eq(users.id, id));
  }

  async updateSessionVersion(id: string): Promise<void> {
    await this.db
      .update(users)
      .set({ sessionVersion: sql`${users.sessionVersion} + 1`, updatedAt: sql`now()` })
      .where(eq(users.id, id));
  }
}
