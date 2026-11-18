/**
 * Minimal public user display data for feature modules.
 *
 * The auth module owns the users table and provides the implementation. Only
 * presentation fields cross the boundary — never email, password, or security
 * state — so a chat list can show names without exposing the account record.
 */
export interface UserSummary {
  id: string;
  username: string | null;
  displayName: string;
  avatarKey: string | null;
}

export interface UserSummaryReader {
  findSummaries(userIds: readonly string[]): Promise<UserSummary[]>;
}
