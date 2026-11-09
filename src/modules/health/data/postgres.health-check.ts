import { inject, injectable } from 'inversify';
import type { Pool } from 'pg';
import { CORE_TYPES } from '@/core/container/core.types.js';
import type { HealthCheck } from '@/modules/health/logic/health-check.js';

@injectable()
export class PostgresHealthCheck implements HealthCheck {
  readonly name = 'postgres';

  constructor(@inject(CORE_TYPES.PgPool) private readonly pool: Pool) {}

  async check(): Promise<void> {
    await this.pool.query('SELECT 1');
  }
}
