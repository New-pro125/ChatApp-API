import { eq } from 'drizzle-orm';
import { inject, injectable } from 'inversify';
import { CORE_TYPES } from '@/core/container/core.types.js';
import type { AppDatabase } from '@/core/database/database.provider.js';
import { userPrivacySettings } from '@/core/database/schema/index.js';
import { PersistenceException } from '@/core/errors/repository.error.js';
import { PrivacySettingsMapper, privacySelection } from '@/modules/auth/data/privacy.mapper.js';
import type { PrivacySettingsRecord } from '@/modules/auth/logic/entities/privacy-settings.js';
import type {
  UpdatePrivacyInput,
  UserPrivacyRepository,
} from '@/modules/auth/logic/ports/user-privacy.repository.js';

/**
 * Reads and lazily creates the privacy row for an account.
 *
 * Writes use an upsert so the first update creates the row with column
 * defaults and later updates only touch the fields the caller supplied.
 */
@injectable()
export class PostgresUserPrivacyRepository implements UserPrivacyRepository {
  private readonly mapper = new PrivacySettingsMapper();

  constructor(@inject(CORE_TYPES.Db) private readonly db: AppDatabase) {}

  async findByUserId(userId: string): Promise<PrivacySettingsRecord | null> {
    const rows = await this.db
      .select(privacySelection)
      .from(userPrivacySettings)
      .where(eq(userPrivacySettings.userId, userId))
      .limit(1);

    const row = rows[0];

    return row ? this.mapper.toRecord(row) : null;
  }

  async upsert(userId: string, input: UpdatePrivacyInput): Promise<PrivacySettingsRecord> {
    const insert: typeof userPrivacySettings.$inferInsert = { userId };
    const update: Partial<typeof userPrivacySettings.$inferInsert> = { updatedAt: new Date() };

    if (input.profilePhotoVisibility !== undefined) {
      insert.profilePhotoVisibility = input.profilePhotoVisibility;
      update.profilePhotoVisibility = input.profilePhotoVisibility;
    }

    if (input.lastSeenVisibility !== undefined) {
      insert.lastSeenVisibility = input.lastSeenVisibility;
      update.lastSeenVisibility = input.lastSeenVisibility;
    }

    if (input.storiesVisibility !== undefined) {
      insert.storiesVisibility = input.storiesVisibility;
      update.storiesVisibility = input.storiesVisibility;
    }

    if (input.readReceiptsEnabled !== undefined) {
      insert.readReceiptsEnabled = input.readReceiptsEnabled;
      update.readReceiptsEnabled = input.readReceiptsEnabled;
    }

    try {
      const rows = await this.db
        .insert(userPrivacySettings)
        .values(insert)
        .onConflictDoUpdate({ target: userPrivacySettings.userId, set: update })
        .returning(privacySelection);

      const row = rows[0];

      if (!row) {
        throw new PersistenceException('PostgreSQL did not return the privacy settings row');
      }

      return this.mapper.toRecord(row);
    } catch (error) {
      if (error instanceof PersistenceException) {
        throw error;
      }

      throw new PersistenceException('Failed to update privacy settings', { cause: error });
    }
  }
}
