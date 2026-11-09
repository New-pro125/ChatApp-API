import { and, count, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { inject, injectable } from 'inversify';
import { CORE_TYPES } from '@/core/container/core.types.js';
import type { AppDatabase } from '@/core/database/database.provider.js';
import { mfaChallenges, mfaRecoveryCodes, users } from '@/core/database/schema/index.js';
import { PersistenceException } from '@/core/errors/repository.error.js';
import {
  MfaChallengeRecord,
  MfaRecoveryCodeRecord,
} from '@/modules/auth/logic/entities/mfa-record.js';
import type {
  CreateMfaChallengeInput,
  MfaRepository,
} from '@/modules/auth/logic/ports/mfa.repository.js';

const challengeSelection = {
  id: mfaChallenges.id,
  userId: mfaChallenges.userId,
  expiresAt: mfaChallenges.expiresAt,
  attempts: mfaChallenges.attempts,
  consumedAt: mfaChallenges.consumedAt,
  createdAt: mfaChallenges.createdAt,
} as const;

const recoveryCodeSelection = {
  id: mfaRecoveryCodes.id,
  userId: mfaRecoveryCodes.userId,
  usedAt: mfaRecoveryCodes.usedAt,
  createdAt: mfaRecoveryCodes.createdAt,
} as const;

/**
 * Persists MFA challenges, TOTP enrollment state, and recovery codes.
 *
 * Challenge and recovery-code secrets are already hashed by the service layer;
 * this repository only stores and conditionally consumes them.
 */
@injectable()
export class PostgresMfaRepository implements MfaRepository {
  constructor(@inject(CORE_TYPES.Db) private readonly db: AppDatabase) {}

  async invalidateChallenges(userId: string): Promise<void> {
    await this.execute('Failed to invalidate MFA challenges', async () => {
      await this.db
        .update(mfaChallenges)
        .set({ consumedAt: sql`now()` })
        .where(and(eq(mfaChallenges.userId, userId), isNull(mfaChallenges.consumedAt)));
    });
  }

  async createChallenge(input: CreateMfaChallengeInput): Promise<void> {
    await this.execute('Failed to create MFA challenge', async () => {
      await this.db.insert(mfaChallenges).values({
        userId: input.userId,
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt,
        requestedIp: input.requestedIp,
      });
    });
  }

  findChallengeByTokenHash(tokenHash: string): Promise<MfaChallengeRecord | null> {
    return this.execute('Failed to load MFA challenge', async () => {
      const rows = await this.db
        .select(challengeSelection)
        .from(mfaChallenges)
        .where(eq(mfaChallenges.tokenHash, tokenHash))
        .limit(1);

      const row = rows[0];

      return row
        ? new MfaChallengeRecord(
            row.id,
            row.userId,
            row.expiresAt,
            row.attempts,
            row.consumedAt,
            row.createdAt,
          )
        : null;
    });
  }

  async incrementChallengeAttempts(id: string): Promise<void> {
    await this.execute('Failed to update MFA challenge', async () => {
      await this.db
        .update(mfaChallenges)
        .set({ attempts: sql`${mfaChallenges.attempts} + 1` })
        .where(eq(mfaChallenges.id, id));
    });
  }

  consumeChallenge(id: string): Promise<boolean> {
    return this.execute('Failed to consume MFA challenge', async () => {
      const rows = await this.db
        .update(mfaChallenges)
        .set({ consumedAt: sql`now()` })
        .where(
          and(
            eq(mfaChallenges.id, id),
            isNull(mfaChallenges.consumedAt),
            sql`${mfaChallenges.expiresAt} > now()`,
          ),
        )
        .returning({ id: mfaChallenges.id });

      return rows.length > 0;
    });
  }

  async startEnrollment(userId: string, secretCiphertext: string, startedAt: Date): Promise<void> {
    await this.execute('Failed to start MFA enrollment', async () => {
      await this.db
        .update(users)
        .set({
          mfaSecretCiphertext: secretCiphertext,
          mfaEnrollmentStartedAt: startedAt,
          mfaEnabled: false,
          mfaEnrolledAt: null,
          mfaLastTotpStep: null,
          updatedAt: sql`now()`,
        })
        .where(eq(users.id, userId));
    });
  }

  async activate(userId: string, enrolledAt: Date, recoveryCodeHashes: string[]): Promise<void> {
    await this.transaction('Failed to activate MFA', async (db) => {
      await db
        .update(users)
        .set({
          mfaEnabled: true,
          mfaEnrolledAt: enrolledAt,
          mfaEnrollmentStartedAt: null,
          updatedAt: sql`now()`,
        })
        .where(eq(users.id, userId));

      await this.replaceRecoveryCodesWith(db, userId, recoveryCodeHashes);
    });
  }

  async disable(userId: string): Promise<void> {
    await this.transaction('Failed to disable MFA', async (db) => {
      await db
        .update(users)
        .set({
          mfaEnabled: false,
          mfaSecretCiphertext: null,
          mfaEnrollmentStartedAt: null,
          mfaEnrolledAt: null,
          mfaLastTotpStep: null,
          updatedAt: sql`now()`,
        })
        .where(eq(users.id, userId));

      await db.delete(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, userId));
    });
  }

  consumeTotpStep(userId: string, step: number): Promise<boolean> {
    return this.execute('Failed to record TOTP step', async () => {
      const rows = await this.db
        .update(users)
        .set({
          mfaLastTotpStep: step,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(users.id, userId),
            or(isNull(users.mfaLastTotpStep), lt(users.mfaLastTotpStep, step)),
          ),
        )
        .returning({ id: users.id });

      return rows.length > 0;
    });
  }

  findRecoveryCode(userId: string, codeHash: string): Promise<MfaRecoveryCodeRecord | null> {
    return this.execute('Failed to load MFA recovery code', async () => {
      const rows = await this.db
        .select(recoveryCodeSelection)
        .from(mfaRecoveryCodes)
        .where(
          and(
            eq(mfaRecoveryCodes.userId, userId),
            eq(mfaRecoveryCodes.codeHash, codeHash),
            isNull(mfaRecoveryCodes.usedAt),
          ),
        )
        .limit(1);

      const row = rows[0];

      return row ? new MfaRecoveryCodeRecord(row.id, row.userId, row.usedAt, row.createdAt) : null;
    });
  }

  markRecoveryCodeUsed(id: string): Promise<boolean> {
    return this.execute('Failed to consume MFA recovery code', async () => {
      const rows = await this.db
        .update(mfaRecoveryCodes)
        .set({ usedAt: sql`now()` })
        .where(and(eq(mfaRecoveryCodes.id, id), isNull(mfaRecoveryCodes.usedAt)))
        .returning({ id: mfaRecoveryCodes.id });

      return rows.length > 0;
    });
  }

  countUnusedRecoveryCodes(userId: string): Promise<number> {
    return this.execute('Failed to count MFA recovery codes', async () => {
      const rows = await this.db
        .select({ total: count() })
        .from(mfaRecoveryCodes)
        .where(and(eq(mfaRecoveryCodes.userId, userId), isNull(mfaRecoveryCodes.usedAt)));

      return Number(rows[0]?.total ?? 0);
    });
  }

  async replaceRecoveryCodes(userId: string, codeHashes: string[]): Promise<void> {
    await this.transaction('Failed to replace MFA recovery codes', (db) =>
      this.replaceRecoveryCodesWith(db, userId, codeHashes),
    );
  }

  private async replaceRecoveryCodesWith(
    db: AppDatabase,
    userId: string,
    codeHashes: string[],
  ): Promise<void> {
    await db.delete(mfaRecoveryCodes).where(eq(mfaRecoveryCodes.userId, userId));

    if (codeHashes.length === 0) {
      return;
    }

    await db.insert(mfaRecoveryCodes).values(codeHashes.map((codeHash) => ({ userId, codeHash })));
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
    work: (db: AppDatabase) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.db.transaction((tx) => work(tx));
    } catch (error) {
      throw new PersistenceException(operation, { cause: error });
    }
  }
}
