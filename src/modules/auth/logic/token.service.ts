import { randomUUID } from 'node:crypto';
import { inject, injectable } from 'inversify';
import type { Logger } from 'pino';
import type { AccessTokenClaims, AccessTokenService } from '@/core/auth/access-token.service.js';
import type { AuthDenylist } from '@/core/auth/auth-denylist.js';
import type { AppConfig } from '@/core/config/app.config.js';
import { CORE_TYPES } from '@/core/container/core.types.js';
import {
  InvalidOAuthGrantException,
  InvalidRefreshTokenException,
} from '@/core/errors/domain.error.js';
import { AUTH_TYPES } from '@/modules/auth/auth.types.js';
import type { TokenGenerator } from '@/modules/auth/data/token.generator.js';
import { AuthenticatedUser } from '@/modules/auth/logic/entities/authenticated-user.js';
import type {
  ActiveSessionRecord,
  DeviceContext,
} from '@/modules/auth/logic/entities/refresh-token-record.js';
import type { OAuthGrantStore } from '@/modules/auth/logic/ports/oauth-grant.store.js';
import type { RefreshTokenRepository } from '@/modules/auth/logic/ports/refresh-token.repository.js';
import type { UserRepository } from '@/modules/auth/logic/ports/user.repository.js';

/** The token pair handed to clients after any successful authentication. */
export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  refreshExpiresAt: Date;
}

export interface AuthenticationTokens {
  user: AuthenticatedUser;
  tokens: IssuedTokens;
}

/**
 * Issues, rotates, and revokes the access/refresh token pair.
 *
 * Refresh tokens are single-use: every refresh marks the presented token
 * rotated and issues a successor in the same family. Presenting a token that
 * was already rotated or revoked is treated as theft: the entire family is
 * revoked so both the attacker and the victim must re-authenticate.
 */
@injectable()
export class TokenService {
  constructor(
    @inject(AUTH_TYPES.UserRepository) private readonly users: UserRepository,
    @inject(AUTH_TYPES.RefreshTokenRepository)
    private readonly refreshTokens: RefreshTokenRepository,
    @inject(AUTH_TYPES.OAuthGrantStore) private readonly grants: OAuthGrantStore,
    @inject(AUTH_TYPES.TokenGenerator) private readonly generator: TokenGenerator,
    @inject(CORE_TYPES.AccessTokenService) private readonly accessTokens: AccessTokenService,
    @inject(CORE_TYPES.AuthDenylist) private readonly denylist: AuthDenylist,
    @inject(CORE_TYPES.Config) private readonly config: AppConfig,
    @inject(CORE_TYPES.Logger) private readonly logger: Logger,
  ) {}

  issue(user: AuthenticatedUser, device: DeviceContext): Promise<IssuedTokens> {
    return this.createPair(user, randomUUID(), device);
  }

  /** Issues a single-use grant code for a browser OAuth callback redirect. */
  issueGrant(userId: string): Promise<string> {
    return this.grants.issue(userId);
  }

  /** Exchanges a grant code for the token pair of the user it was issued for. */
  async exchangeGrant(code: string, device: DeviceContext): Promise<AuthenticationTokens> {
    const userId = await this.grants.consume(code);

    if (userId === null) {
      throw new InvalidOAuthGrantException();
    }

    const user = await this.users.findById(userId);

    if (!user) {
      throw new InvalidOAuthGrantException();
    }

    const authenticated = AuthenticatedUser.fromRecord(user);

    return {
      user: authenticated,
      tokens: await this.createPair(authenticated, randomUUID(), device),
    };
  }

  async refresh(rawToken: string): Promise<AuthenticationTokens> {
    const presented = await this.refreshTokens.findByTokenHash(
      this.generator.hashResetToken(rawToken),
    );

    if (!presented) {
      throw new InvalidRefreshTokenException();
    }

    if (presented.revokedAt !== null || presented.rotatedAt !== null) {
      await this.revokeForReuse(presented);
      throw new InvalidRefreshTokenException('Refresh token reuse detected');
    }

    if (presented.expiresAt.getTime() <= Date.now()) {
      throw new InvalidRefreshTokenException('Refresh token has expired');
    }

    const user = await this.users.findById(presented.userId);

    if (!user || user.lockedUntil !== null) {
      throw new InvalidRefreshTokenException();
    }

    const now = new Date();
    const rotatedFamily = await this.refreshTokens.markRotated(presented.id, now);

    if (rotatedFamily === null) {
      // Another concurrent request consumed this token between read and write.
      await this.revokeForReuse(presented);
      throw new InvalidRefreshTokenException('Refresh token reuse detected');
    }

    const authenticated = AuthenticatedUser.fromRecord(user);
    const tokens = await this.createPair(authenticated, presented.familyId, {
      deviceName: presented.deviceName ?? undefined,
      deviceType: presented.deviceType ?? undefined,
      clientIp: presented.clientIp,
      userAgent: presented.userAgent,
    });

    return { user: authenticated, tokens };
  }

  /**
   * Logs out the calling device: the presented access token dies immediately
   * and, when the client supplies its refresh token, the whole lineage stops
   * refreshing.
   */
  async logout(rawRefreshToken: string | undefined, claims: AccessTokenClaims): Promise<void> {
    await this.denylist.revokeAccessToken(claims);
    await this.denylist.revokeRefreshToken(claims.refreshTokenId, this.refreshTtlSeconds());

    if (rawRefreshToken === undefined) {
      return;
    }

    const revoked = await this.refreshTokens.revokeByTokenHash(
      this.generator.hashResetToken(rawRefreshToken),
      'logout',
      new Date(),
    );

    if (revoked !== null) {
      await this.denylist.revokeRefreshToken(revoked.id, this.remainingSeconds(revoked.expiresAt));
    }
  }

  async logoutAll(userId: string): Promise<void> {
    await this.users.updateSessionVersion(userId);
    await this.refreshTokens.revokeAllForUser(userId, 'logout_all', new Date());
  }

  listSessions(userId: string): Promise<ActiveSessionRecord[]> {
    return this.refreshTokens.listActiveForUser(userId);
  }

  async revokeSession(userId: string, sessionId: string): Promise<ActiveSessionRecord | null> {
    const sessions = await this.refreshTokens.listActiveForUser(userId);
    const target = sessions.find((session) => session.id === sessionId);

    if (!target) {
      return null;
    }

    const revoked = await this.refreshTokens.revokeByIdAndUser(
      sessionId,
      userId,
      'revoked_session',
      new Date(),
    );

    if (!revoked) {
      return null;
    }

    await this.denylist.revokeRefreshToken(sessionId, this.remainingSeconds(target.expiresAt));

    return target;
  }

  private async createPair(
    user: AuthenticatedUser,
    familyId: string,
    device: DeviceContext,
  ): Promise<IssuedTokens> {
    const now = new Date();
    const rawRefreshToken = this.generator.generateResetToken();
    const expiresAt = new Date(now.getTime() + this.refreshTtlMs());

    const record = await this.refreshTokens.create({
      userId: user.id,
      familyId,
      tokenHash: this.generator.hashResetToken(rawRefreshToken),
      expiresAt,
      deviceName: device.deviceName ?? null,
      deviceType: device.deviceType ?? null,
      clientIp: device.clientIp,
      userAgent: device.userAgent,
    });

    const access = await this.accessTokens.sign(
      user.id,
      user.sessionVersion,
      record.id,
      familyId,
      now,
    );

    return {
      accessToken: access.token,
      refreshToken: rawRefreshToken,
      tokenType: 'Bearer',
      expiresIn: this.accessTokens.accessTokenTtlSeconds,
      refreshExpiresAt: expiresAt,
    };
  }

  private async revokeForReuse(presented: {
    id: string;
    userId: string;
    familyId: string;
  }): Promise<void> {
    const revokedCount = await this.refreshTokens.revokeFamily(
      presented.familyId,
      'reuse_detected',
      new Date(),
    );

    this.logger.warn(
      {
        userId: presented.userId,
        familyId: presented.familyId,
        refreshTokenId: presented.id,
        revokedCount,
      },
      'Refresh token reuse detected; revoked the token family',
    );
  }

  private remainingSeconds(expiresAt: Date): number {
    return Math.max(1, Math.ceil((expiresAt.getTime() - Date.now()) / 1000));
  }

  private refreshTtlMs(): number {
    return this.refreshTtlSeconds() * 1000;
  }

  private refreshTtlSeconds(): number {
    return this.config.tokens.refreshTokenTtlSeconds;
  }
}
