import type { InferSelectModel } from 'drizzle-orm';
import { userPrivacySettings } from '@/core/database/schema/index.js';
import {
  PrivacySettingsRecord,
  type PrivacyVisibility,
} from '@/modules/auth/logic/entities/privacy-settings.js';

/**
 * Explicit column selection for the `user_privacy_settings` table.
 */
export const privacySelection = {
  profilePhotoVisibility: userPrivacySettings.profilePhotoVisibility,
  lastSeenVisibility: userPrivacySettings.lastSeenVisibility,
  storiesVisibility: userPrivacySettings.storiesVisibility,
  readReceiptsEnabled: userPrivacySettings.readReceiptsEnabled,
} as const;

export type PrivacyRow = Pick<
  InferSelectModel<typeof userPrivacySettings>,
  keyof typeof privacySelection
>;

export class PrivacySettingsMapper {
  toRecord(row: PrivacyRow): PrivacySettingsRecord {
    return new PrivacySettingsRecord(
      row.profilePhotoVisibility as PrivacyVisibility,
      row.lastSeenVisibility as PrivacyVisibility,
      row.storiesVisibility as PrivacyVisibility,
      row.readReceiptsEnabled,
    );
  }
}
