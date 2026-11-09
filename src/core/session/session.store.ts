import { RedisStore } from 'connect-redis';
import type { Store } from 'express-session';
import type { AppConfig } from '@/core/config/app.config.js';
import type { RedisClient } from '@/types/redis.js';

export class SessionStoreFactory {
  create(client: RedisClient, config: AppConfig): Store {
    return new RedisStore({
      client,
      prefix: 'sess:',
      ttl: config.sessionTtlSeconds,
    });
  }
}
