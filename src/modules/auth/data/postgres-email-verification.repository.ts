import { and, desc, eq, type InferSelectModel, sql } from 'drizzle-orm';
import { inject, injectable } from 'inversify';
import { CORE_TYPES } from '@/core/container/core.types.js';
import type { AppDatabase } from '@/core/database/database.provider.js';
import { emailVerificationCodes } from '@/core/database/schema/index.js';
import { EmailVerificationCodeRecord } from '@/modules/auth/logic/entities/email-verification-code.js';
import type {
  CreateEmailVerificationCodeInput,
  EmailVerificationRepository,
} from '@/modules/auth/logic/ports/email-verification.repository.js';

const verificationSelection = {
  id: emailVerificationCodes.id,
  userId: emailVerificationCodes.userId,
  codeHash: emailVerificationCodes.codeHash,
  expiresAt: emailVerificationCodes.expiresAt,
  attempts: emailVerificationCodes.attempts,
  consumedAt: emailVerificationCodes.consumedAt,
  requestedIp: emailVerificationCodes.requestedIp,
  createdAt: emailVerificationCodes.createdAt,
} as const;

type EmailVerificationRow = Pick<
  InferSelectModel<typeof emailVerificationCodes>,
  keyof typeof verificationSelection
>;

export class EmailVerificationRowMapper {
  toRecord(row: EmailVerificationRow): EmailVerificationCodeRecord {
    return new EmailVerificationCodeRecord(
      row.id,
      row.userId,
      row.codeHash,
      row.expiresAt,
      row.attempts,
      row.consumedAt,
      row.requestedIp,
      row.createdAt,
    );
  }
}

@injectable()
export class PostgresEmailVerificationRepository implements EmailVerificationRepository {
  private readonly mapper = new EmailVerificationRowMapper();

  constructor(@inject(CORE_TYPES.Db) private readonly db: AppDatabase) {}

  async lastCreatedAt(userId: string): Promise<Date | null> {
    const rows = await this.db
      .select({ createdAt: emailVerificationCodes.createdAt })
      .from(emailVerificationCodes)
      .where(eq(emailVerificationCodes.userId, userId))
      .orderBy(desc(emailVerificationCodes.createdAt))
      .limit(1);

    return rows[0]?.createdAt ?? null;
  }

  async invalidateActive(userId: string): Promise<void> {
    await this.db
      .update(emailVerificationCodes)
      .set({
        consumedAt: sql`coalesce(${emailVerificationCodes.consumedAt}, now())`,
      })
      .where(
        and(
          eq(emailVerificationCodes.userId, userId),
          sql`${emailVerificationCodes.consumedAt} is null`,
        ),
      );
  }

  async create(input: CreateEmailVerificationCodeInput): Promise<void> {
    await this.db.insert(emailVerificationCodes).values({
      userId: input.userId,
      codeHash: input.codeHash,
      expiresAt: input.expiresAt,
      requestedIp: input.requestedIp,
    });
  }

  async findActive(userId: string): Promise<EmailVerificationCodeRecord | null> {
    const rows = await this.db
      .select(verificationSelection)
      .from(emailVerificationCodes)
      .where(
        and(
          eq(emailVerificationCodes.userId, userId),
          sql`${emailVerificationCodes.consumedAt} is null`,
          sql`${emailVerificationCodes.expiresAt} > now()`,
        ),
      )
      .orderBy(desc(emailVerificationCodes.createdAt))
      .limit(1);

    const row = rows[0];

    return row ? this.mapper.toRecord(row) : null;
  }

  async incrementAttempts(id: string): Promise<void> {
    await this.db
      .update(emailVerificationCodes)
      .set({ attempts: sql`${emailVerificationCodes.attempts} + 1` })
      .where(eq(emailVerificationCodes.id, id));
  }

  async markConsumed(id: string): Promise<void> {
    await this.db
      .update(emailVerificationCodes)
      .set({ consumedAt: sql`now()` })
      .where(eq(emailVerificationCodes.id, id));
  }
}
