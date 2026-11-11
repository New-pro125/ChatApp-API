import { inject, injectable } from 'inversify';
import type { Logger } from 'pino';
import type { AccessTokenClaims } from '@/core/auth/access-token.service.js';
import { CORE_TYPES } from '@/core/container/core.types.js';
import type { RedisClient } from '@/types/redis.js';

const REFRESH_PREFIX = 'auth:deny:rt:';
const ACCESS_PREFIX = 'auth:deny:jti:';

/**
 * Redis-backed revocation list for access and refresh tokens.
 *
 * Logging out a single device must kill its outstanding access token before
 * the JWT expires, so the middleware consults this list on every request. If
 * Redis is unavailable the check fails open: tokens then only expire by TTL,
 * which is bounded by the access-token lifetime.
 */
@injectable()
export class AuthDenylist {
  constructor(
    @inject(CORE_TYPES.RedisClient) private readonly redis: RedisClient,
    @inject(CORE_TYPES.Logger) private readonly logger: Logger,
  ) {}

  async revokeRefreshToken(id: string, ttlSeconds: number): Promise<void> {
    await this.set(`${REFRESH_PREFIX}${id}`, ttlSeconds);
  }

  async revokeAccessToken(claims: AccessTokenClaims): Promise<void> {
    const remainingSeconds = Math.ceil((claims.expiresAt.getTime() - Date.now()) / 1000);

    if (remainingSeconds <= 0) {
      return;
    }

    await this.set(`${ACCESS_PREFIX}${claims.jti}`, remainingSeconds);
  }

  async isRevoked(claims: AccessTokenClaims): Promise<boolean> {
    try {
      const results = await this.redis.mGet([
        `${REFRESH_PREFIX}${claims.refreshTokenId}`,
        `${ACCESS_PREFIX}${claims.jti}`,
      ]);

      return results.some((value) => value !== null);
    } catch (error) {
      this.logger.error(
        { err: error },
        'Auth denylist lookup failed; failing open until token expiry',
      );
      return false;
    }
  }

  private async set(key: string, ttlSeconds: number): Promise<void> {
    try {
      await this.redis.set(key, '1', { EX: Math.max(1, ttlSeconds) });
    } catch (error) {
      this.logger.error({ err: error, key }, 'Auth denylist write failed');
    }
  }
}
