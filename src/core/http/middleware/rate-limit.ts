import type { RequestHandler } from 'express';
import rateLimit from 'express-rate-limit';
import { inject, injectable } from 'inversify';
import { type RedisReply, RedisStore } from 'rate-limit-redis';
import { CORE_TYPES } from '@/core/container/core.types.js';
import { RateLimitedException } from '@/core/errors/http.error.js';
import type { RedisClient } from '@/types/redis.js';

interface RedisRateLimiterOptions {
  windowMs: number;
  limit: number;
  prefix: string;
  message: string;
}

/**
 * Redis-backed fixed-window limiter shared by the auth buckets.
 *
 * Each subclass owns its own prefix so unrelated flows (login/register vs.
 * profile edits) do not consume one another's quota. The middleware is built
 * lazily in `initialize()` because the Redis store uploads its Lua scripts at
 * construction time, which requires an established connection.
 */
abstract class RedisRateLimiter {
  private middleware: RequestHandler | undefined;

  readonly handle: RequestHandler = (req, res, next) => {
    if (!this.middleware) {
      next(new Error('Rate limiter is not initialized'));
      return;
    }

    this.middleware(req, res, next);
  };

  constructor(
    private readonly client: RedisClient,
    private readonly options: RedisRateLimiterOptions,
  ) {}

  initialize(): void {
    this.middleware ??= rateLimit({
      windowMs: this.options.windowMs,
      limit: this.options.limit,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      store: new RedisStore({
        prefix: this.options.prefix,
        sendCommand: (...args: string[]) => this.client.sendCommand(args) as Promise<RedisReply>,
      }),
      handler: (_req, _res, next) => {
        next(new RateLimitedException(this.options.message));
      },
    });
  }
}

const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;

@injectable()
export class AuthRateLimiter extends RedisRateLimiter {
  constructor(@inject(CORE_TYPES.RedisClient) client: RedisClient) {
    super(client, {
      windowMs: FIFTEEN_MINUTES_MS,
      limit: 20,
      prefix: 'rl:auth:',
      message: 'Too many authentication attempts. Try again later.',
    });
  }
}

@injectable()
export class ProfileRateLimiter extends RedisRateLimiter {
  constructor(@inject(CORE_TYPES.RedisClient) client: RedisClient) {
    super(client, {
      windowMs: FIFTEEN_MINUTES_MS,
      limit: 30,
      prefix: 'rl:profile:',
      message: 'Too many profile updates. Try again later.',
    });
  }
}

@injectable()
export class StoryRateLimiter extends RedisRateLimiter {
  constructor(@inject(CORE_TYPES.RedisClient) client: RedisClient) {
    super(client, {
      windowMs: FIFTEEN_MINUTES_MS,
      limit: 30,
      prefix: 'rl:stories:',
      message: 'Too many story updates. Try again later.',
    });
  }
}

/** Limits chat and message writes across all messaging endpoints. */
@injectable()
export class MessagesRateLimiter extends RedisRateLimiter {
  constructor(@inject(CORE_TYPES.RedisClient) client: RedisClient) {
    super(client, {
      windowMs: FIFTEEN_MINUTES_MS,
      limit: 120,
      prefix: 'rl:messages:',
      message: 'Too many messaging actions. Try again later.',
    });
  }
}

/** Limits device registration, rotation, and bundle fetches. */
@injectable()
export class E2eeRateLimiter extends RedisRateLimiter {
  constructor(@inject(CORE_TYPES.RedisClient) client: RedisClient) {
    super(client, {
      windowMs: FIFTEEN_MINUTES_MS,
      limit: 30,
      prefix: 'rl:e2ee:',
      message: 'Too many E2EE key operations. Try again later.',
    });
  }
}

/** Limits upload tickets, finalize attempts, and signed URL issuance. */
@injectable()
export class MediaRateLimiter extends RedisRateLimiter {
  constructor(@inject(CORE_TYPES.RedisClient) client: RedisClient) {
    super(client, {
      windowMs: FIFTEEN_MINUTES_MS,
      limit: 30,
      prefix: 'rl:media:',
      message: 'Too many media operations. Try again later.',
    });
  }
}
