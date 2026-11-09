import type { Router } from 'express';
import { inject, injectable } from 'inversify';
import { CORE_TYPES } from '@/core/container/core.types.js';
import type { AuthRateLimiter } from '@/core/http/middleware/rate-limit.js';
import type { RequestScopeMiddleware } from '@/core/http/middleware/request-scope.js';
import { RequireAuthMiddleware } from '@/core/http/middleware/require-auth.js';
import { DocumentedRouter } from '@/core/http/openapi/documented-router.js';
import type { OpenApiRegistry } from '@/core/http/openapi/openapi.registry.js';
import { AUTH_TYPES } from '@/modules/auth/auth.types.js';
import type { AuthController } from '@/modules/auth/web/auth.controller.js';
import { authContracts } from '@/modules/auth/web/dto/auth.openapi.js';
import type { MfaController } from '@/modules/auth/web/mfa.controller.js';
import type { PasswordResetController } from '@/modules/auth/web/password-reset.controller.js';
import type { OAuthRouter } from '@/modules/auth/web/routes/oauth.router.js';

@injectable()
export class AuthRouter {
  readonly router: Router;

  private readonly routes: DocumentedRouter;
  private readonly requireAuth = new RequireAuthMiddleware();

  constructor(
    @inject(AUTH_TYPES.RequestScope) scope: RequestScopeMiddleware,
    @inject(AUTH_TYPES.OAuthRouter) oauthRouter: OAuthRouter,
    @inject(AUTH_TYPES.AuthRateLimiter) private readonly limiter: AuthRateLimiter,
    @inject(CORE_TYPES.OpenApiRegistry) registry: OpenApiRegistry,
  ) {
    this.routes = new DocumentedRouter(registry, '/api/auth');
    this.router = this.routes.router;
    this.router.use(scope.handle);

    this.routes.post('/register', authContracts.register, this.limiter.handle, (req, res, next) => {
      return req.container.get<AuthController>(AUTH_TYPES.AuthController).register(req, res, next);
    });

    this.routes.post('/login', authContracts.login, this.limiter.handle, (req, res, next) => {
      return req.container.get<AuthController>(AUTH_TYPES.AuthController).login(req, res, next);
    });

    this.routes.post(
      '/mfa/verify',
      authContracts.verifyMfa,
      this.limiter.handle,
      (req, res, next) => {
        return req.container.get<MfaController>(AUTH_TYPES.MfaController).verify(req, res, next);
      },
    );

    this.routes.post(
      '/mfa/enroll',
      authContracts.enrollMfa,
      this.limiter.handle,
      this.requireAuth.handle,
      (req, res, next) => {
        return req.container.get<MfaController>(AUTH_TYPES.MfaController).enroll(req, res, next);
      },
    );

    this.routes.post(
      '/mfa/enroll/confirm',
      authContracts.confirmMfaEnrollment,
      this.limiter.handle,
      this.requireAuth.handle,
      (req, res, next) => {
        return req.container
          .get<MfaController>(AUTH_TYPES.MfaController)
          .confirmEnrollment(req, res, next);
      },
    );

    this.routes.get(
      '/mfa/status',
      authContracts.mfaStatus,
      this.requireAuth.handle,
      (req, res, next) => {
        return req.container.get<MfaController>(AUTH_TYPES.MfaController).status(req, res, next);
      },
    );

    this.routes.post(
      '/mfa/disable',
      authContracts.disableMfa,
      this.limiter.handle,
      this.requireAuth.handle,
      (req, res, next) => {
        return req.container.get<MfaController>(AUTH_TYPES.MfaController).disable(req, res, next);
      },
    );

    this.routes.post(
      '/mfa/recovery-codes/regenerate',
      authContracts.regenerateRecoveryCodes,
      this.limiter.handle,
      this.requireAuth.handle,
      (req, res, next) => {
        return req.container
          .get<MfaController>(AUTH_TYPES.MfaController)
          .regenerateRecoveryCodes(req, res, next);
      },
    );

    this.routes.post('/logout', authContracts.logout, (req, res, next) => {
      return req.container.get<AuthController>(AUTH_TYPES.AuthController).logout(req, res, next);
    });

    this.routes.get('/me', authContracts.me, this.requireAuth.handle, (req, res, next) => {
      return req.container.get<AuthController>(AUTH_TYPES.AuthController).me(req, res, next);
    });

    this.routes.post(
      '/password/forgot',
      authContracts.forgotPassword,
      this.limiter.handle,
      (req, res, next) => {
        return req.container
          .get<PasswordResetController>(AUTH_TYPES.PasswordResetController)
          .forgot(req, res, next);
      },
    );

    this.routes.post(
      '/password/verify-otp',
      authContracts.verifyPasswordOtp,
      this.limiter.handle,
      (req, res, next) => {
        return req.container
          .get<PasswordResetController>(AUTH_TYPES.PasswordResetController)
          .verifyOtp(req, res, next);
      },
    );

    this.routes.post(
      '/password/reset',
      authContracts.resetPassword,
      this.limiter.handle,
      (req, res, next) => {
        return req.container
          .get<PasswordResetController>(AUTH_TYPES.PasswordResetController)
          .reset(req, res, next);
      },
    );

    this.router.use(oauthRouter.router);
  }
}
