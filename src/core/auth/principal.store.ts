/**
 * The user record attached to authenticated requests.
 *
 * The auth module provides the implementation; every other module resolves it
 * through the root container without importing the auth module.
 */
export interface Principal {
  id: string;
  email: string;
  displayName: string;
  username: string | null;
  bio: string | null;
  phone: string | null;
  avatarKey: string | null;
  createdAt: Date;
  sessionVersion: number;
  mfaEnabled: boolean;
  mfaEnrolledAt: Date | null;
  emailVerifiedAt: Date | null;
  readonly isEmailVerified: boolean;
}

/**
 * Resolves the current state of a user for an access token.
 *
 * Returning null rejects the request: the session version in the token must
 * still match the stored one, which is how password changes, global logout,
 * and administrative bans invalidate outstanding access tokens.
 */
export interface PrincipalStore {
  resolve(userId: string, sessionVersion: number): Promise<Principal | null>;
}
