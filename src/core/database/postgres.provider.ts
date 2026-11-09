import { Pool } from 'pg';
import type { Logger } from 'pino';
import type { AppConfig } from '@/core/config/app.config.js';

export class PostgresProvider {
  readonly pool: Pool;

  constructor(config: AppConfig, logger: Logger) {
    this.pool = new Pool({
      connectionString: config.databaseUrl,
      max: 10,
      application_name: 'inversify-passport',
    });

    this.pool.on('error', (error) => {
      logger.error({ err: error }, 'Postgres pool error');
    });
  }

  async connect(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  async dispose(): Promise<void> {
    await this.pool.end();
  }
}
