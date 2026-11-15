import { and, desc, eq, type InferSelectModel, isNull, sql } from 'drizzle-orm';
import { inject, injectable } from 'inversify';
import { CORE_TYPES } from '@/core/container/core.types.js';
import type { AppDatabase } from '@/core/database/database.provider.js';
import { emailVerificationCodes, users } from '@/core/database/schema/index.js';
import { PersistenceException } from '@/core/errors/repository.error.js';
import { EmailVerificationCodeRecord } from '@/modules/auth/logic/entities/email-verification-code.js';
import type {
  EmailVerificationRepository,
  IssueEmailVerificationCodeInput,
  IssueEmailVerificationCodeResult,
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

  issue(input: IssueEmailVerificationCodeInput): Promise<IssueEmailVerificationCodeResult> {
    return this.transaction('Failed to issue email verification code', async (tx) => {
      // Serialize issuance per user so two concurrent resends cannot both pass
      // the cooldown check. The owner row always exists for authenticated and
      // freshly registered callers; a missing row fails the insert below.
      await tx.execute(
        sql`select ${users.id} from ${users} where ${users.id} = ${input.userId} for update`,
      );

      const recent = await tx
        .select({
          retryAfterSeconds: sql<number>`
            coalesce(
              greatest(
                0,
                ceil(
                  extract(
                    epoch from (
                      max(${emailVerificationCodes.createdAt})
                      + (${input.cooldownSeconds} * interval '1 second')
                      - now()
                    )
                  )
                )
              ),
              0
            )::int
          `,
        })
        .from(emailVerificationCodes)
        .where(eq(emailVerificationCodes.userId, input.userId));

      const retryAfterSeconds = recent[0]?.retryAfterSeconds ?? 0;

      if (retryAfterSeconds > 0) {
        return { issued: false as const, retryAfterSeconds };
      }

      await tx
        .update(emailVerificationCodes)
        .set({ consumedAt: sql`now()` })
        .where(
          and(
            eq(emailVerificationCodes.userId, input.userId),
            isNull(emailVerificationCodes.consumedAt),
          ),
        );

      const rows = await tx
        .insert(emailVerificationCodes)
        .values({
          userId: input.userId,
          codeHash: input.codeHash,
          expiresAt: sql`now() + (${input.ttlSeconds} * interval '1 second')`,
          requestedIp: input.requestedIp,
        })
        .returning({ expiresAt: emailVerificationCodes.expiresAt });

      const row = rows[0];

      if (!row) {
        throw new PersistenceException('PostgreSQL did not return the issued verification code');
      }

      return { issued: true as const, expiresAt: row.expiresAt };
    });
  }

  findActive(userId: string): Promise<EmailVerificationCodeRecord | null> {
    return this.execute('Failed to load email verification code', async () => {
      const rows = await this.db
        .select(verificationSelection)
        .from(emailVerificationCodes)
        .where(
          and(
            eq(emailVerificationCodes.userId, userId),
            isNull(emailVerificationCodes.consumedAt),
            sql`${emailVerificationCodes.expiresAt} > now()`,
          ),
        )
        .orderBy(desc(emailVerificationCodes.createdAt))
        .limit(1);

      const row = rows[0];

      return row ? this.mapper.toRecord(row) : null;
    });
  }

  incrementAttempts(id: string, maxAttempts: number): Promise<boolean> {
    return this.execute('Failed to record email verification attempt', async () => {
      const rows = await this.db
        .update(emailVerificationCodes)
        .set({ attempts: sql`${emailVerificationCodes.attempts} + 1` })
        .where(
          and(
            eq(emailVerificationCodes.id, id),
            sql`${emailVerificationCodes.attempts} < ${maxAttempts}`,
          ),
        )
        .returning({ id: emailVerificationCodes.id });

      return rows.length > 0;
    });
  }

  consumeAndMarkVerified(id: string, userId: string, verifiedAt: Date): Promise<boolean> {
    return this.transaction('Failed to consume email verification code', async (tx) => {
      const rows = await tx
        .update(emailVerificationCodes)
        .set({ consumedAt: sql`now()` })
        .where(
          and(
            eq(emailVerificationCodes.id, id),
            isNull(emailVerificationCodes.consumedAt),
            sql`${emailVerificationCodes.expiresAt} > now()`,
          ),
        )
        .returning({ id: emailVerificationCodes.id });

      if (rows.length === 0) {
        return false;
      }

      await tx
        .update(users)
        .set({
          emailVerifiedAt: verifiedAt,
          updatedAt: sql`now()`,
        })
        .where(eq(users.id, userId));

      return true;
    });
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
      if (error instanceof PersistenceException) {
        throw error;
      }

      throw new PersistenceException(operation, { cause: error });
    }
  }
}
