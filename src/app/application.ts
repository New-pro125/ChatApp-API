import type { Server } from 'node:http';
import cors from 'cors';
import express, { type Express } from 'express';
import type { Store } from 'express-session';
import helmet from 'helmet';
import type { AppContainer, PassportStatic } from '@/core/container/app.container.js';
import { CORE_TYPES } from '@/core/container/core.types.js';
import type { ErrorMapper } from '@/core/errors/error-mapper.js';
import { ErrorHandlerMiddleware } from '@/core/http/middleware/error-handler.js';
import { NotFoundMiddleware } from '@/core/http/middleware/not-found.js';
import { RequestIdMiddleware } from '@/core/http/middleware/request-id.js';
import type { ApiDocumentBuilder } from '@/core/http/openapi/api-document.builder.js';
import { DocsRouter } from '@/core/http/openapi/docs.router.js';
import type { ApiResponse } from '@/core/http/response/api-response.js';
import type { AppModule } from '@/core/modules/app.module.js';
import { SessionMiddleware } from '@/core/session/session.middleware.js';
import { AuthModule } from '@/modules/auth/auth.module.js';
import { HealthModule } from '@/modules/health/health.module.js';

export class Application {
  private readonly app: Express;
  private readonly modules: AppModule[];
  private server: Server | undefined;
  private started: boolean = false;

  constructor(private readonly container: AppContainer) {
    const { config, logger } = container;
    const passport = container.get<PassportStatic>(CORE_TYPES.Passport);
    const sessionStore = container.get<Store>(CORE_TYPES.SessionStore);
    const errorMapper = container.get<ErrorMapper>(CORE_TYPES.ErrorMapper);
    const apiResponse = container.get<ApiResponse>(CORE_TYPES.ApiResponse);

    this.app = express();
    this.app.disable('x-powered-by');

    if (config.nodeEnv === 'production') {
      this.app.set('trust proxy', 1);
    }

    this.app.use(new RequestIdMiddleware().handle);
    this.app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
    this.app.use(cors({ origin: config.appOrigin, credentials: true }));
    this.app.use(express.json({ limit: '100kb' }));
    this.app.use(new SessionMiddleware(config, sessionStore).handle);
    this.app.use(passport.initialize());
    this.app.use(passport.session());

    this.modules = [new HealthModule(container), new AuthModule(container, config)];

    if (config.docsEnabled) {
      const documents = container.get<ApiDocumentBuilder>(CORE_TYPES.ApiDocumentBuilder);
      this.app.use('/api', new DocsRouter(documents).router);
    }

    for (const module of this.modules) {
      this.app.use(module.mountPath, module.router);
    }

    this.app.use(new NotFoundMiddleware().handle);
    this.app.use(new ErrorHandlerMiddleware(logger, errorMapper, apiResponse).handle);
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    await this.container.connect();

    for (const module of this.modules) {
      await module.configure();
    }

    const { config, logger } = this.container;

    await new Promise<void>((resolve) => {
      this.server = this.app.listen(config.port, () => {
        logger.info({ port: config.port, environment: config.nodeEnv }, 'API listening');
        resolve();
      });
    });

    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }

    this.started = false;

    await new Promise<void>((resolve, reject) => {
      if (!this.server) {
        resolve();
        return;
      }

      this.server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });

    for (const module of this.modules) {
      await module.dispose();
    }

    await this.container.dispose();
  }
}
