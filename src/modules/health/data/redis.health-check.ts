import { inject, injectable } from 'inversify';
import { CORE_TYPES } from '@/core/container/core.types.js';
import type { HealthCheck } from '@/modules/health/logic/health-check.js';
import type { RedisClient } from '@/types/redis.js';

@injectable()
export class RedisHealthCheck implements HealthCheck {
  readonly name = 'redis';

  constructor(@inject(CORE_TYPES.RedisClient) private readonly client: RedisClient) {}

  async check(): Promise<void> {
    await this.client.ping();
  }
}
