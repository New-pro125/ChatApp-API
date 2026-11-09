import type { Logger } from 'pino';
import { createClient } from 'redis';
import type { AppConfig } from '@/core/config/app.config.js';
import type { RedisClient } from '@/types/redis.js';

export class RedisProvider {
  readonly client: RedisClient;

  constructor(config: AppConfig, logger: Logger) {
    this.client = createClient({ url: config.redisUrl });

    this.client.on('error', (error) => {
      logger.error({ err: error }, 'Redis client error');
    });
  }

  async connect(): Promise<void> {
    await this.client.connect();
  }

  async dispose(): Promise<void> {
    await this.client.quit();
  }
}
