import type { RequestHandler } from 'express';
import rateLimit from 'express-rate-limit';
import { inject, injectable } from 'inversify';
import { type RedisReply, RedisStore } from 'rate-limit-redis';
import { CORE_TYPES } from '@/core/container/core.types.js';
import { RateLimitedException } from '@/core/errors/http.error.js';
import type { RedisClient } from '@/types/redis.js';

const AUTH_RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const AUTH_RATE_LIMIT_MAX = 20;
const AUTH_RATE_LIMIT_PREFIX = 'rl:auth:';

@injectable()
export class AuthRateLimiter {
  private middleware: RequestHandler | undefined;

  readonly handle: RequestHandler = (req, res, next) => {
    if (!this.middleware) {
      next(new Error('Auth rate limiter is not initialized'));
      return;
    }

    this.middleware(req, res, next);
  };

  constructor(@inject(CORE_TYPES.RedisClient) private readonly client: RedisClient) {}

  /**
   * Builds the Redis-backed middleware after the application has connected to
   * Redis. The Redis store uploads its Lua scripts during initialization.
   */
  initialize(): void {
    this.middleware ??= rateLimit({
      windowMs: AUTH_RATE_LIMIT_WINDOW_MS,
      limit: AUTH_RATE_LIMIT_MAX,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      store: new RedisStore({
        prefix: AUTH_RATE_LIMIT_PREFIX,
        sendCommand: (...args: string[]) => this.client.sendCommand(args) as Promise<RedisReply>,
      }),
      handler: (_req, _res, next) => {
        next(new RateLimitedException('Too many authentication attempts. Try again later.'));
      },
    });
  }
}
