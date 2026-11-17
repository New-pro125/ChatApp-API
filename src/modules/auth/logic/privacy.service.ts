import { inject, injectable } from 'inversify';
import type { UserPrivacyReader } from '@/core/privacy/user-privacy.reader.js';
import { AUTH_TYPES } from '@/modules/auth/auth.types.js';
import { PrivacySettingsRecord } from '@/modules/auth/logic/entities/privacy-settings.js';
import type {
  UpdatePrivacyInput,
  UserPrivacyRepository,
} from '@/modules/auth/logic/ports/user-privacy.repository.js';

/**
 * Owns the caller's privacy preferences.
 *
 * Reads fall back to the column defaults when the account has never written
 * them, so callers always receive a complete settings object. Updates are
 * partial: omitted fields keep their stored value.
 *
 * The service also implements the core `UserPrivacyReader` port so other
 * modules can ask privacy questions without importing auth internals.
 */
@injectable()
export class PrivacyService implements UserPrivacyReader {
  constructor(
    @inject(AUTH_TYPES.UserPrivacyRepository) private readonly privacy: UserPrivacyRepository,
  ) {}

  async get(userId: string): Promise<PrivacySettingsRecord> {
    const stored = await this.privacy.findByUserId(userId);

    return stored ?? PrivacySettingsRecord.defaults();
  }

  update(userId: string, input: UpdatePrivacyInput): Promise<PrivacySettingsRecord> {
    return this.privacy.upsert(userId, input);
  }

  async canViewStories(ownerId: string, viewerId: string): Promise<boolean> {
    if (ownerId === viewerId) {
      return true;
    }

    const settings = await this.get(ownerId);

    return settings.storiesVisibility === 'everyone';
  }
}
