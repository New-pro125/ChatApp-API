import type { Router } from 'express';
import { inject, injectable, multiInject } from 'inversify';
import type passport from 'passport';
import type { AppConfig } from '@/core/config/app.config.js';
import { CORE_TYPES } from '@/core/container/core.types.js';
import { DocumentedRouter } from '@/core/http/openapi/documented-router.js';
import type { OpenApiRegistry } from '@/core/http/openapi/openapi.registry.js';
import { AUTH_TYPES } from '@/modules/auth/auth.types.js';
import { oauthBeginContract, oauthCallbackContract } from '@/modules/auth/web/dto/auth.openapi.js';
import type { OAuthController } from '@/modules/auth/web/oauth.controller.js';
import type { PassportProvider } from '@/modules/auth/web/passport/passport.provider.js';

type PassportStatic = typeof passport;

interface OAuthAuthenticateOptions {
  scope?: string | string[];
  state?: boolean;
  session?: boolean;
  failureRedirect?: string;
}

@injectable()
export class OAuthRouter {
  readonly router: Router;

  constructor(
    @inject(CORE_TYPES.Passport) passport: PassportStatic,
    @inject(AUTH_TYPES.OAuthController) controller: OAuthController,
    @inject(CORE_TYPES.Config) config: AppConfig,
    @multiInject(AUTH_TYPES.OAuthProvider) providers: PassportProvider[],
    @inject(CORE_TYPES.OpenApiRegistry) registry: OpenApiRegistry,
  ) {
    const routes = new DocumentedRouter(registry, '/api/auth');
    this.router = routes.router;

    for (const provider of providers) {
      const beginOptions: OAuthAuthenticateOptions = {
        scope: provider.scope,
        state: true,
      };
      const callbackOptions: OAuthAuthenticateOptions = {
        session: false,
        state: true,
        failureRedirect: config.oauthFailureRedirect,
      };

      const beginAuthenticate = passport.authenticate(
        provider.name,
        beginOptions as unknown as passport.AuthenticateOptions,
      );
      const callbackAuthenticate = passport.authenticate(
        provider.name,
        callbackOptions as unknown as passport.AuthenticateOptions,
      );

      routes.get(`/${provider.routePath}`, oauthBeginContract(provider.name), beginAuthenticate);

      routes.get(
        `/${provider.routePath}/callback`,
        oauthCallbackContract(provider.name),
        callbackAuthenticate,
        (req, res, next) => controller.complete(req, res, next),
      );
    }
  }
}
