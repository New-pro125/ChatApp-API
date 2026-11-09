import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import type { Logger } from 'pino';
import type { AppConfig } from '@/core/config/app.config.js';
import * as schema from '@/core/database/schema/index.js';

export type AppDatabase = NodePgDatabase<typeof schema>;

/**
 * Owns the PostgreSQL connection pool and the Drizzle client.
 *
 * Repositories inject the Drizzle database through `CORE_TYPES.Db`; only the
 * health check and migrations need the raw pool.
 */
export class DatabaseProvider {
  readonly pool: Pool;
  readonly db: AppDatabase;

  constructor(config: AppConfig, logger: Logger) {
    this.pool = new Pool({
      connectionString: config.databaseUrl,
      max: config.databasePoolMax,
      application_name: 'inversify-passport',
      statement_timeout: config.databaseStatementTimeoutMs,
      query_timeout: config.databaseStatementTimeoutMs + 1000,
      idleTimeoutMillis: config.databaseIdleTimeoutMs,
      connectionTimeoutMillis: config.databaseConnectionTimeoutMs,
    });

    this.pool.on('error', (error) => {
      logger.error({ err: error }, 'Postgres pool error');
    });

    this.db = drizzle(this.pool, { schema });
  }

  async connect(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  async dispose(): Promise<void> {
    await this.pool.end();
  }
}
