import { Container } from 'inversify';
import passport from 'passport';
import type { Pool } from 'pg';
import type { Logger } from 'pino';
import { AccessTokenService } from '@/core/auth/access-token.service.js';
import { AuthDenylist } from '@/core/auth/auth-denylist.js';
import { RedisProvider } from '@/core/cache/redis.provider.js';
import { AppConfig } from '@/core/config/app.config.js';
import { CORE_TYPES } from '@/core/container/core.types.js';
import { type AppDatabase, DatabaseProvider } from '@/core/database/database.provider.js';
import { ErrorMapper } from '@/core/errors/error-mapper.js';
import { ApiDocumentBuilder } from '@/core/http/openapi/api-document.builder.js';
import { OpenApiRegistry } from '@/core/http/openapi/openapi.registry.js';
import { ApiResponse } from '@/core/http/response/api-response.js';
import { LoggerProvider } from '@/core/logging/logger.provider.js';
import { MetricsService } from '@/core/metrics/metrics.service.js';
import type { RedisClient } from '@/types/redis.js';

export type PassportStatic = typeof passport;

export class AppContainer extends Container {
  readonly config: AppConfig;
  readonly logger: Logger;

  private readonly database: DatabaseProvider;
  private readonly redis: RedisProvider;

  constructor() {
    super();

    this.config = new AppConfig();
    this.logger = new LoggerProvider(this.config).logger;
    this.database = new DatabaseProvider(this.config, this.logger);
    this.redis = new RedisProvider(this.config, this.logger);

    const accessTokenService = new AccessTokenService(this.config, this.logger);
    const authDenylist = new AuthDenylist(this.redis.client, this.logger);

    this.bind<AppConfig>(CORE_TYPES.Config).toConstantValue(this.config);
    this.bind<Logger>(CORE_TYPES.Logger).toConstantValue(this.logger);
    this.bind<Pool>(CORE_TYPES.PgPool).toConstantValue(this.database.pool);
    this.bind<AppDatabase>(CORE_TYPES.Db).toConstantValue(this.database.db);
    this.bind<RedisClient>(CORE_TYPES.RedisClient).toConstantValue(this.redis.client);
    this.bind<PassportStatic>(CORE_TYPES.Passport).toConstantValue(passport);

    this.bind<AccessTokenService>(CORE_TYPES.AccessTokenService).toConstantValue(
      accessTokenService,
    );
    this.bind<AuthDenylist>(CORE_TYPES.AuthDenylist).toConstantValue(authDenylist);

    this.bind<ApiResponse>(CORE_TYPES.ApiResponse).to(ApiResponse).inSingletonScope();
    this.bind<ErrorMapper>(CORE_TYPES.ErrorMapper).to(ErrorMapper).inSingletonScope();
    this.bind<OpenApiRegistry>(CORE_TYPES.OpenApiRegistry).to(OpenApiRegistry).inSingletonScope();
    this.bind<ApiDocumentBuilder>(CORE_TYPES.ApiDocumentBuilder)
      .to(ApiDocumentBuilder)
      .inSingletonScope();
    this.bind<MetricsService>(CORE_TYPES.Metrics).to(MetricsService).inSingletonScope();
  }

  async connect(): Promise<void> {
    await this.database.connect();
    await this.redis.connect();
  }

  async dispose(): Promise<void> {
    await this.redis.dispose();
    await this.database.dispose();
    this.unbindAll();
  }
}
