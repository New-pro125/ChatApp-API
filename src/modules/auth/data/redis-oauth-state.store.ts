import { randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import { inject, injectable } from 'inversify';
import type { AppConfig } from '@/core/config/app.config.js';
import { CORE_TYPES } from '@/core/container/core.types.js';
import type {
  OAuthStatePayload,
  OAuthStateStore,
} from '@/modules/auth/logic/ports/oauth-state.store.js';
import type { RedisClient } from '@/types/redis.js';

/**
 * Redis-backed OAuth state store with an opaque httpOnly cookie as the key.
 *
 * The cookie carries no state itself — only the id of the Redis entry — so
 * PKCE code verifiers never reach the browser.
 */
@injectable()
export class RedisOAuthStateStore implements OAuthStateStore {
  constructor(
    @inject(CORE_TYPES.RedisClient) private readonly redis: RedisClient,
    @inject(CORE_TYPES.Config) private readonly config: AppConfig,
  ) {}

  async save(req: Request, payload: OAuthStatePayload): Promise<void> {
    const key = randomBytes(16).toString('base64url');
    const ttlSeconds = this.config.tokens.oauthStateTtlSeconds;

    await this.redis.set(`oauth:state:${key}`, JSON.stringify(payload), { EX: ttlSeconds });

    this.response(req)?.cookie(this.config.tokens.oauthStateCookieName, key, {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.config.nodeEnv === 'production',
      path: '/',
      maxAge: ttlSeconds * 1000,
    });
  }

  async consume(req: Request): Promise<OAuthStatePayload | null> {
    const key = req.cookies?.[this.config.tokens.oauthStateCookieName];

    this.response(req)?.clearCookie(this.config.tokens.oauthStateCookieName, { path: '/' });

    if (typeof key !== 'string') {
      return null;
    }

    const raw = await this.redis.getDel(`oauth:state:${key}`);

    if (raw === null) {
      return null;
    }

    return this.parse(raw);
  }

  private response(req: Request): Response | undefined {
    return req.res;
  }

  private parse(raw: string): OAuthStatePayload | null {
    try {
      const value = JSON.parse(raw) as { state?: unknown; codeVerifier?: unknown };

      if (typeof value.state !== 'string') {
        return null;
      }

      return {
        state: value.state,
        ...(typeof value.codeVerifier === 'string' ? { codeVerifier: value.codeVerifier } : {}),
      };
    } catch {
      return null;
    }
  }
}
