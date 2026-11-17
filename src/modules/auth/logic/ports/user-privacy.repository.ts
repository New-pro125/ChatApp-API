import type {
  PrivacySettingsRecord,
  PrivacyVisibility,
} from '@/modules/auth/logic/entities/privacy-settings.js';

/**
 * A partial privacy update. Omitted keys are left unchanged, which lets the
 * API accept single-field PATCHes without read-modify-write races.
 */
export interface UpdatePrivacyInput {
  profilePhotoVisibility?: PrivacyVisibility | undefined;
  lastSeenVisibility?: PrivacyVisibility | undefined;
  storiesVisibility?: PrivacyVisibility | undefined;
  readReceiptsEnabled?: boolean | undefined;
}

export interface UserPrivacyRepository {
  findByUserId(userId: string): Promise<PrivacySettingsRecord | null>;
  upsert(userId: string, input: UpdatePrivacyInput): Promise<PrivacySettingsRecord>;
}
