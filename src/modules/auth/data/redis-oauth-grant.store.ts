import { createHash, randomBytes } from 'node:crypto';
import { inject, injectable } from 'inversify';
import type { AppConfig } from '@/core/config/app.config.js';
import { CORE_TYPES } from '@/core/container/core.types.js';
import type { OAuthGrantStore } from '@/modules/auth/logic/ports/oauth-grant.store.js';
import type { RedisClient } from '@/types/redis.js';

const KEY_PREFIX = 'oauth:grant:';

/** Redis-backed single-use grant codes with a short TTL. */
@injectable()
export class RedisOAuthGrantStore implements OAuthGrantStore {
  constructor(
    @inject(CORE_TYPES.RedisClient) private readonly redis: RedisClient,
    @inject(CORE_TYPES.Config) private readonly config: AppConfig,
  ) {}

  async issue(userId: string): Promise<string> {
    const code = randomBytes(32).toString('base64url');

    await this.redis.set(`${KEY_PREFIX}${this.hash(code)}`, userId, {
      EX: this.config.tokens.oauthGrantTtlSeconds,
    });

    return code;
  }

  async consume(code: string): Promise<string | null> {
    const userId = await this.redis.getDel(`${KEY_PREFIX}${this.hash(code)}`);

    return userId ?? null;
  }

  private hash(code: string): string {
    return createHash('sha256').update(code).digest('hex');
  }
}
