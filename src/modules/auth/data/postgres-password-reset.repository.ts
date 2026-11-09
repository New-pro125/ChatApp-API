import { and, desc, eq, type InferSelectModel, sql } from 'drizzle-orm';
import { inject, injectable } from 'inversify';
import { CORE_TYPES } from '@/core/container/core.types.js';
import type { AppDatabase } from '@/core/database/database.provider.js';
import { passwordResetCodes } from '@/core/database/schema/index.js';
import { PasswordResetCodeRecord } from '@/modules/auth/logic/entities/password-reset-code.js';
import type {
  CreatePasswordResetCodeInput,
  PasswordResetRepository,
} from '@/modules/auth/logic/ports/password-reset.repository.js';

const resetSelection = {
  id: passwordResetCodes.id,
  userId: passwordResetCodes.userId,
  codeHash: passwordResetCodes.codeHash,
  expiresAt: passwordResetCodes.expiresAt,
  attempts: passwordResetCodes.attempts,
  consumedAt: passwordResetCodes.consumedAt,
  resetTokenHash: passwordResetCodes.resetTokenHash,
  tokenExpiresAt: passwordResetCodes.tokenExpiresAt,
  tokenUsedAt: passwordResetCodes.tokenUsedAt,
  createdAt: passwordResetCodes.createdAt,
} as const;

type PasswordResetRow = Pick<
  InferSelectModel<typeof passwordResetCodes>,
  keyof typeof resetSelection
>;

export class PasswordResetRowMapper {
  toRecord(row: PasswordResetRow): PasswordResetCodeRecord {
    return new PasswordResetCodeRecord(
      row.id,
      row.userId,
      row.codeHash,
      row.expiresAt,
      row.attempts,
      row.consumedAt,
      row.resetTokenHash,
      row.tokenExpiresAt,
      row.tokenUsedAt,
      row.createdAt,
    );
  }
}

/**
 * Persists OTP codes and the single-use reset tokens derived from them.
 *
 * Expiry comparisons use the database clock (`now()`) so multiple API replicas
 * with slightly different clocks cannot disagree about token validity.
 */
@injectable()
export class PostgresPasswordResetRepository implements PasswordResetRepository {
  private readonly mapper = new PasswordResetRowMapper();

  constructor(@inject(CORE_TYPES.Db) private readonly db: AppDatabase) {}

  async lastCreatedAt(userId: string): Promise<Date | null> {
    const rows = await this.db
      .select({ createdAt: passwordResetCodes.createdAt })
      .from(passwordResetCodes)
      .where(eq(passwordResetCodes.userId, userId))
      .orderBy(desc(passwordResetCodes.createdAt))
      .limit(1);

    return rows[0]?.createdAt ?? null;
  }

  async invalidateActive(userId: string): Promise<void> {
    await this.db
      .update(passwordResetCodes)
      .set({
        consumedAt: sql`coalesce(${passwordResetCodes.consumedAt}, now())`,
        tokenUsedAt: sql`case
          when ${passwordResetCodes.resetTokenHash} is not null
            and ${passwordResetCodes.tokenUsedAt} is null
          then now()
          else ${passwordResetCodes.tokenUsedAt}
        end`,
      })
      .where(
        and(
          eq(passwordResetCodes.userId, userId),
          sql`(
            ${passwordResetCodes.consumedAt} is null
            or (${passwordResetCodes.resetTokenHash} is not null
              and ${passwordResetCodes.tokenUsedAt} is null)
          )`,
        ),
      );
  }

  async create(input: CreatePasswordResetCodeInput): Promise<void> {
    await this.db.insert(passwordResetCodes).values({
      userId: input.userId,
      codeHash: input.codeHash,
      expiresAt: input.expiresAt,
      requestedIp: input.requestedIp,
    });
  }

  async findActive(userId: string): Promise<PasswordResetCodeRecord | null> {
    const rows = await this.db
      .select(resetSelection)
      .from(passwordResetCodes)
      .where(
        and(
          eq(passwordResetCodes.userId, userId),
          sql`${passwordResetCodes.consumedAt} is null`,
          sql`${passwordResetCodes.expiresAt} > now()`,
        ),
      )
      .orderBy(desc(passwordResetCodes.createdAt))
      .limit(1);

    const row = rows[0];

    return row ? this.mapper.toRecord(row) : null;
  }

  async incrementAttempts(id: string): Promise<void> {
    await this.db
      .update(passwordResetCodes)
      .set({ attempts: sql`${passwordResetCodes.attempts} + 1` })
      .where(eq(passwordResetCodes.id, id));
  }

  async markOtpVerified(id: string, tokenHash: string, tokenExpiresAt: Date): Promise<void> {
    await this.db
      .update(passwordResetCodes)
      .set({
        consumedAt: sql`now()`,
        resetTokenHash: tokenHash,
        tokenExpiresAt,
      })
      .where(eq(passwordResetCodes.id, id));
  }

  async findByTokenHash(tokenHash: string): Promise<PasswordResetCodeRecord | null> {
    const rows = await this.db
      .select(resetSelection)
      .from(passwordResetCodes)
      .where(eq(passwordResetCodes.resetTokenHash, tokenHash))
      .limit(1);

    const row = rows[0];

    return row ? this.mapper.toRecord(row) : null;
  }

  async markTokenUsed(id: string): Promise<void> {
    await this.db
      .update(passwordResetCodes)
      .set({ tokenUsedAt: sql`now()` })
      .where(eq(passwordResetCodes.id, id));
  }
}
