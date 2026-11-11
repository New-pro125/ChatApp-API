import type {
  ActiveSessionRecord,
  RefreshTokenRecord,
} from '@/modules/auth/logic/entities/refresh-token-record.js';

export interface CreateRefreshTokenInput {
  userId: string;
  familyId: string;
  tokenHash: string;
  expiresAt: Date;
  deviceName: string | null;
  deviceType: string | null;
  clientIp: string | null;
  userAgent: string | null;
}

/**
 * Persistence for rotating refresh tokens.
 *
 * Implementations must make rotation conditional (a token can be rotated or
 * revoked exactly once) so concurrent refresh attempts cannot mint two
 * successors from the same token.
 */
export interface RefreshTokenRepository {
  create(input: CreateRefreshTokenInput): Promise<RefreshTokenRecord>;

  findByTokenHash(tokenHash: string): Promise<RefreshTokenRecord | null>;

  /** Marks a token rotated; returns null when it was not in an active state. */
  markRotated(id: string, rotatedAt: Date): Promise<string | null>;

  /** Marks a token revoked; returns null when it was not in an active state. */
  revokeByTokenHash(
    tokenHash: string,
    reason: string,
    revokedAt: Date,
  ): Promise<RefreshTokenRecord | null>;

  revokeByIdAndUser(id: string, userId: string, reason: string, revokedAt: Date): Promise<boolean>;

  revokeAllForUser(userId: string, reason: string, revokedAt: Date): Promise<number>;

  revokeFamily(familyId: string, reason: string, revokedAt: Date): Promise<number>;

  listActiveForUser(userId: string): Promise<ActiveSessionRecord[]>;
}
