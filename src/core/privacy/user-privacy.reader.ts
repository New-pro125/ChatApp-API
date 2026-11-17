/**
 * Read-only view of a user's privacy preferences for other modules.
 *
 * The auth module owns the `user_privacy_settings` table and provides the
 * implementation; feature modules (stories now, messaging and search later)
 * resolve this through the root container so they never import auth internals.
 * Only primitive identifiers cross the boundary; the policy itself stays in
 * auth.
 */
export interface UserPrivacyReader {
  /**
   * Whether `viewerId` may see the stories owned by `ownerId`.
   *
   * A user always sees their own stories. Otherwise the owner's
   * `storiesVisibility` setting decides: `everyone` allows any authenticated
   * viewer and `nobody` hides the stories from everyone else.
   */
  canViewStories(ownerId: string, viewerId: string): Promise<boolean>;
}
