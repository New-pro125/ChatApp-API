import compression from 'compression';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import type { AppContainer, PassportStatic } from '@/core/container/app.container.js';
import { CORE_TYPES } from '@/core/container/core.types.js';
import type { ErrorMapper } from '@/core/errors/error-mapper.js';
import { RequestLoggerMiddleware } from '@/core/http/logging/request-logger.js';
import { ErrorHandlerMiddleware } from '@/core/http/middleware/error-handler.js';
import { NotFoundMiddleware } from '@/core/http/middleware/not-found.js';
import { RequestIdMiddleware } from '@/core/http/middleware/request-id.js';
import type { ApiDocumentBuilder } from '@/core/http/openapi/api-document.builder.js';
import { DocsRouter } from '@/core/http/openapi/docs.router.js';
import type { ApiResponse } from '@/core/http/response/api-response.js';
import { HttpServer } from '@/core/http/server/http-server.js';
import { MetricsRouter } from '@/core/metrics/metrics.router.js';
import type { MetricsService } from '@/core/metrics/metrics.service.js';
import type { AppModule } from '@/core/modules/app.module.js';
import { AuthModule } from '@/modules/auth/auth.module.js';
import { E2eeModule } from '@/modules/e2ee/e2ee.module.js';
import { HealthModule } from '@/modules/health/health.module.js';
import { MessagesModule } from '@/modules/messages/messages.module.js';
import { StoriesModule } from '@/modules/stories/stories.module.js';

export class Application {
  private readonly app: Express;
  private readonly modules: AppModule[];
  private readonly server: HttpServer;
  private initialized: boolean = false;
  private started: boolean = false;

  constructor(private readonly container: AppContainer) {
    const { config, logger } = container;
    const passport = container.get<PassportStatic>(CORE_TYPES.Passport);
    const errorMapper = container.get<ErrorMapper>(CORE_TYPES.ErrorMapper);
    const apiResponse = container.get<ApiResponse>(CORE_TYPES.ApiResponse);
    const metrics = container.get<MetricsService>(CORE_TYPES.Metrics);

    this.app = express();
    this.app.disable('x-powered-by');
    this.app.disable('etag');
    this.app.set('query parser', 'simple');
    this.app.set('trust proxy', config.http.trustProxy);

    this.app.use(new RequestIdMiddleware().handle);
    this.app.use(new RequestLoggerMiddleware(logger).handle);

    this.app.use(
      helmet({
        contentSecurityPolicy: config.docsEnabled
          ? false
          : { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
        crossOriginResourcePolicy: { policy: 'cross-origin' },
        hsts:
          config.nodeEnv === 'production'
            ? { maxAge: 15_552_000, includeSubDomains: true, preload: false }
            : false,
      }),
    );

    this.app.use(
      cors({
        origin: config.http.corsOrigins.length === 0 ? false : [...config.http.corsOrigins],
        credentials: true,
      }),
    );

    this.app.use(
      compression({
        threshold: config.http.compressionThresholdBytes,
      }),
    );

    this.app.use((_req, res, next) => {
      res.setHeader('Cache-Control', 'no-store');
      next();
    });

    this.app.use(metrics.middleware);
    this.app.use(cookieParser());
    this.app.use(express.json({ limit: config.http.bodyLimitBytes }));

    if (config.http.metricsEnabled) {
      this.app.use('/metrics', new MetricsRouter(metrics, config).router);
    }

    this.app.use(passport.initialize());

    this.modules = [
      new HealthModule(container),
      new AuthModule(container, config),
      new StoriesModule(container),
      new E2eeModule(container),
      new MessagesModule(container),
    ];

    if (config.docsEnabled) {
      const documents = container.get<ApiDocumentBuilder>(CORE_TYPES.ApiDocumentBuilder);
      this.app.use('/api', new DocsRouter(documents).router);
    }

    for (const module of this.modules) {
      this.app.use(module.mountPath, module.router);
    }

    this.app.use(new NotFoundMiddleware().handle);
    this.app.use(new ErrorHandlerMiddleware(logger, errorMapper, apiResponse).handle);

    this.server = new HttpServer(this.app, config, logger);
  }

  get expressApp(): Express {
    return this.app;
  }

  get rootContainer(): AppContainer {
    return this.container;
  }

  getModule<T extends AppModule>(name: string): T | undefined {
    return this.modules.find((module) => module.name === name) as T | undefined;
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    await this.container.connect();

    for (const module of this.modules) {
      await module.configure();
    }

    this.initialized = true;
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    await this.initialize();
    await this.server.listen();

    const { config, logger } = this.container;
    logger.info({ port: config.port, environment: config.nodeEnv }, 'API listening');

    this.started = true;
  }

  async stop(): Promise<void> {
    if (this.started) {
      this.started = false;
      await this.server.close();
    }

    if (this.initialized) {
      this.initialized = false;

      for (const module of this.modules) {
        await module.dispose();
      }

      await this.container.dispose();
    }
  }
}
