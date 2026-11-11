import { and, desc, eq, gt, type InferSelectModel, isNull, sql } from 'drizzle-orm';
import { inject, injectable } from 'inversify';
import { CORE_TYPES } from '@/core/container/core.types.js';
import { PostgresErrorInspector } from '@/core/database/database.error-inspector.js';
import type { AppDatabase } from '@/core/database/database.provider.js';
import { refreshTokens } from '@/core/database/schema/index.js';
import { PersistenceException, UniqueConstraintException } from '@/core/errors/repository.error.js';
import {
  ActiveSessionRecord,
  RefreshTokenRecord,
} from '@/modules/auth/logic/entities/refresh-token-record.js';
import type {
  CreateRefreshTokenInput,
  RefreshTokenRepository,
} from '@/modules/auth/logic/ports/refresh-token.repository.js';

/** Explicit column selection for the `refresh_tokens` table. */
const selection = {
  id: refreshTokens.id,
  userId: refreshTokens.userId,
  familyId: refreshTokens.familyId,
  tokenHash: refreshTokens.tokenHash,
  deviceName: refreshTokens.deviceName,
  deviceType: refreshTokens.deviceType,
  clientIp: refreshTokens.clientIp,
  userAgent: refreshTokens.userAgent,
  expiresAt: refreshTokens.expiresAt,
  lastUsedAt: refreshTokens.lastUsedAt,
  rotatedAt: refreshTokens.rotatedAt,
  revokedAt: refreshTokens.revokedAt,
  revokedReason: refreshTokens.revokedReason,
  createdAt: refreshTokens.createdAt,
} as const;

type RefreshTokenRow = Pick<InferSelectModel<typeof refreshTokens>, keyof typeof selection>;

/**
 * Reads and writes the rotating refresh tokens.
 *
 * Rotations and revocations are conditional updates so a token can only be
 * consumed once even under concurrent requests.
 */
@injectable()
export class PostgresRefreshTokenRepository implements RefreshTokenRepository {
  private readonly errors = new PostgresErrorInspector();

  constructor(@inject(CORE_TYPES.Db) private readonly db: AppDatabase) {}

  async create(input: CreateRefreshTokenInput): Promise<RefreshTokenRecord> {
    try {
      const rows = await this.db
        .insert(refreshTokens)
        .values({
          userId: input.userId,
          familyId: input.familyId,
          tokenHash: input.tokenHash,
          expiresAt: input.expiresAt,
          deviceName: input.deviceName,
          deviceType: input.deviceType,
          clientIp: input.clientIp,
          userAgent: input.userAgent,
          lastUsedAt: new Date(),
        })
        .returning(selection);

      const row = rows[0];

      if (!row) {
        throw new PersistenceException('PostgreSQL did not return the created refresh token');
      }

      return this.toRecord(row);
    } catch (error) {
      if (error instanceof PersistenceException) {
        throw error;
      }

      if (this.errors.isUniqueViolation(error)) {
        throw new UniqueConstraintException(
          this.errors.constraintName(error) ?? 'refresh_tokens_token_hash_unique',
          { cause: error },
        );
      }

      throw new PersistenceException('Failed to create refresh token', { cause: error });
    }
  }

  async findByTokenHash(tokenHash: string): Promise<RefreshTokenRecord | null> {
    const rows = await this.db
      .select(selection)
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, tokenHash))
      .limit(1);

    const row = rows[0];

    return row ? this.toRecord(row) : null;
  }

  async markRotated(id: string, rotatedAt: Date): Promise<string | null> {
    const rows = await this.db
      .update(refreshTokens)
      .set({ rotatedAt, updatedAt: sql`now()` })
      .where(
        and(
          eq(refreshTokens.id, id),
          isNull(refreshTokens.rotatedAt),
          isNull(refreshTokens.revokedAt),
        ),
      )
      .returning({ familyId: refreshTokens.familyId });

    return rows[0]?.familyId ?? null;
  }

  async revokeByTokenHash(
    tokenHash: string,
    reason: string,
    revokedAt: Date,
  ): Promise<RefreshTokenRecord | null> {
    const rows = await this.db
      .update(refreshTokens)
      .set({ revokedAt, revokedReason: reason, updatedAt: sql`now()` })
      .where(
        and(
          eq(refreshTokens.tokenHash, tokenHash),
          isNull(refreshTokens.rotatedAt),
          isNull(refreshTokens.revokedAt),
        ),
      )
      .returning(selection);

    const row = rows[0];

    return row ? this.toRecord(row) : null;
  }

  async revokeByIdAndUser(
    id: string,
    userId: string,
    reason: string,
    revokedAt: Date,
  ): Promise<boolean> {
    const rows = await this.db
      .update(refreshTokens)
      .set({ revokedAt, revokedReason: reason, updatedAt: sql`now()` })
      .where(
        and(
          eq(refreshTokens.id, id),
          eq(refreshTokens.userId, userId),
          isNull(refreshTokens.rotatedAt),
          isNull(refreshTokens.revokedAt),
        ),
      )
      .returning({ id: refreshTokens.id });

    return rows.length > 0;
  }

  async revokeAllForUser(userId: string, reason: string, revokedAt: Date): Promise<number> {
    const rows = await this.db
      .update(refreshTokens)
      .set({ revokedAt, revokedReason: reason, updatedAt: sql`now()` })
      .where(
        and(
          eq(refreshTokens.userId, userId),
          isNull(refreshTokens.rotatedAt),
          isNull(refreshTokens.revokedAt),
        ),
      )
      .returning({ id: refreshTokens.id });

    return rows.length;
  }

  async revokeFamily(familyId: string, reason: string, revokedAt: Date): Promise<number> {
    const rows = await this.db
      .update(refreshTokens)
      .set({ revokedAt, revokedReason: reason, updatedAt: sql`now()` })
      .where(and(eq(refreshTokens.familyId, familyId), isNull(refreshTokens.revokedAt)))
      .returning({ id: refreshTokens.id });

    return rows.length;
  }

  async listActiveForUser(userId: string): Promise<ActiveSessionRecord[]> {
    const rows = await this.db
      .select({
        id: refreshTokens.id,
        deviceName: refreshTokens.deviceName,
        deviceType: refreshTokens.deviceType,
        clientIp: refreshTokens.clientIp,
        userAgent: refreshTokens.userAgent,
        createdAt: refreshTokens.createdAt,
        lastUsedAt: refreshTokens.lastUsedAt,
        expiresAt: refreshTokens.expiresAt,
      })
      .from(refreshTokens)
      .where(
        and(
          eq(refreshTokens.userId, userId),
          isNull(refreshTokens.rotatedAt),
          isNull(refreshTokens.revokedAt),
          gt(refreshTokens.expiresAt, new Date()),
        ),
      )
      .orderBy(desc(refreshTokens.createdAt));

    return rows.map(
      (row) =>
        new ActiveSessionRecord(
          row.id,
          row.deviceName,
          row.deviceType,
          row.clientIp,
          row.userAgent,
          row.createdAt,
          row.lastUsedAt,
          row.expiresAt,
        ),
    );
  }

  private toRecord(row: RefreshTokenRow): RefreshTokenRecord {
    return new RefreshTokenRecord(
      row.id,
      row.userId,
      row.familyId,
      row.tokenHash,
      row.deviceName,
      row.deviceType,
      row.clientIp,
      row.userAgent,
      row.expiresAt,
      row.lastUsedAt,
      row.rotatedAt,
      row.revokedAt,
      row.revokedReason,
      row.createdAt,
    );
  }
}
