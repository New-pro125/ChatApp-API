import type { Store } from 'express-session';
import { Container } from 'inversify';
import passport from 'passport';
import type { Pool } from 'pg';
import type { Logger } from 'pino';
import { RedisProvider } from '@/core/cache/redis.provider.js';
import { AppConfig } from '@/core/config/app.config.js';
import { CORE_TYPES } from '@/core/container/core.types.js';
import { PostgresProvider } from '@/core/database/postgres.provider.js';
import { ErrorMapper } from '@/core/errors/error-mapper.js';
import { ApiResponse } from '@/core/http/response/api-response.js';
import { LoggerProvider } from '@/core/logging/logger.provider.js';
import { SessionStoreFactory } from '@/core/session/session.store.js';
import type { RedisClient } from '@/types/redis.js';

export type PassportStatic = typeof passport;

export class AppContainer extends Container {
  readonly config: AppConfig;
  readonly logger: Logger;

  private readonly postgres: PostgresProvider;
  private readonly redis: RedisProvider;

  constructor() {
    super();

    this.config = new AppConfig();
    this.logger = new LoggerProvider(this.config).logger;
    this.postgres = new PostgresProvider(this.config, this.logger);
    this.redis = new RedisProvider(this.config, this.logger);

    const sessionStore = new SessionStoreFactory().create(this.redis.client, this.config);

    this.bind<AppConfig>(CORE_TYPES.Config).toConstantValue(this.config);
    this.bind<Logger>(CORE_TYPES.Logger).toConstantValue(this.logger);
    this.bind<Pool>(CORE_TYPES.PgPool).toConstantValue(this.postgres.pool);
    this.bind<RedisClient>(CORE_TYPES.RedisClient).toConstantValue(this.redis.client);
    this.bind<Store>(CORE_TYPES.SessionStore).toConstantValue(sessionStore);
    this.bind<PassportStatic>(CORE_TYPES.Passport).toConstantValue(passport);

    this.bind<ApiResponse>(CORE_TYPES.ApiResponse).to(ApiResponse).inSingletonScope();
    this.bind<ErrorMapper>(CORE_TYPES.ErrorMapper).to(ErrorMapper).inSingletonScope();
  }

  async connect(): Promise<void> {
    await this.postgres.connect();
    await this.redis.connect();
  }

  async dispose(): Promise<void> {
    await this.redis.dispose();
    await this.postgres.dispose();
    this.unbindAll();
  }
}
