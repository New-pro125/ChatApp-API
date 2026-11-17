/**
 * Who may see a piece of a user's activity.
 *
 * `contacts` arrives in a later phase alongside the contact graph; until then
 * the only meaningful choices are "everyone" and "nobody".
 */
export type PrivacyVisibility = 'everyone' | 'nobody';

/**
 * The privacy preferences of one account.
 *
 * Rows are created lazily on the first write, so a missing row means "still on
 * the defaults" rather than an error. `defaults()` mirrors the column defaults
 * in the `user_privacy_settings` table so reads stay consistent before the
 * first write.
 */
export class PrivacySettingsRecord {
  constructor(
    readonly profilePhotoVisibility: PrivacyVisibility,
    readonly lastSeenVisibility: PrivacyVisibility,
    readonly storiesVisibility: PrivacyVisibility,
    readonly readReceiptsEnabled: boolean,
  ) {}

  static defaults(): PrivacySettingsRecord {
    return new PrivacySettingsRecord('everyone', 'everyone', 'everyone', true);
  }
}
