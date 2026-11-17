import { inject, injectable } from 'inversify';
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
 */
@injectable()
export class PrivacyService {
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
}
