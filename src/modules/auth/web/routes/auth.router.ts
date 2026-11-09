import { Router } from 'express';
import { inject, injectable } from 'inversify';
import type { AuthRateLimiter } from '@/core/http/middleware/rate-limit.js';
import type { RequestScopeMiddleware } from '@/core/http/middleware/request-scope.js';
import { RequireAuthMiddleware } from '@/core/http/middleware/require-auth.js';
import { AUTH_TYPES } from '@/modules/auth/auth.types.js';
import type { AuthController } from '@/modules/auth/web/auth.controller.js';
import type { MfaController } from '@/modules/auth/web/mfa.controller.js';
import type { PasswordResetController } from '@/modules/auth/web/password-reset.controller.js';
import type { OAuthRouter } from '@/modules/auth/web/routes/oauth.router.js';

@injectable()
export class AuthRouter {
  readonly router = Router();

  private readonly requireAuth = new RequireAuthMiddleware();

  constructor(
    @inject(AUTH_TYPES.RequestScope) scope: RequestScopeMiddleware,
    @inject(AUTH_TYPES.OAuthRouter) oauthRouter: OAuthRouter,
    @inject(AUTH_TYPES.AuthRateLimiter) private readonly limiter: AuthRateLimiter,
  ) {
    this.router.use(scope.handle);

    this.router.post('/register', this.limiter.handle, (req, res, next) => {
      return req.container.get<AuthController>(AUTH_TYPES.AuthController).register(req, res, next);
    });

    this.router.post('/login', this.limiter.handle, (req, res, next) => {
      return req.container.get<AuthController>(AUTH_TYPES.AuthController).login(req, res, next);
    });

    this.router.post('/mfa/verify', this.limiter.handle, (req, res, next) => {
      return req.container.get<MfaController>(AUTH_TYPES.MfaController).verify(req, res, next);
    });

    this.router.post(
      '/mfa/enroll',
      this.limiter.handle,
      this.requireAuth.handle,
      (req, res, next) => {
        return req.container.get<MfaController>(AUTH_TYPES.MfaController).enroll(req, res, next);
      },
    );

    this.router.post(
      '/mfa/enroll/confirm',
      this.limiter.handle,
      this.requireAuth.handle,
      (req, res, next) => {
        return req.container
          .get<MfaController>(AUTH_TYPES.MfaController)
          .confirmEnrollment(req, res, next);
      },
    );

    this.router.get('/mfa/status', this.requireAuth.handle, (req, res, next) => {
      return req.container.get<MfaController>(AUTH_TYPES.MfaController).status(req, res, next);
    });

    this.router.post(
      '/mfa/disable',
      this.limiter.handle,
      this.requireAuth.handle,
      (req, res, next) => {
        return req.container.get<MfaController>(AUTH_TYPES.MfaController).disable(req, res, next);
      },
    );

    this.router.post(
      '/mfa/recovery-codes/regenerate',
      this.limiter.handle,
      this.requireAuth.handle,
      (req, res, next) => {
        return req.container
          .get<MfaController>(AUTH_TYPES.MfaController)
          .regenerateRecoveryCodes(req, res, next);
      },
    );

    this.router.post('/logout', (req, res, next) => {
      return req.container.get<AuthController>(AUTH_TYPES.AuthController).logout(req, res, next);
    });

    this.router.get('/me', this.requireAuth.handle, (req, res, next) => {
      return req.container.get<AuthController>(AUTH_TYPES.AuthController).me(req, res, next);
    });

    this.router.post('/password/forgot', this.limiter.handle, (req, res, next) => {
      return req.container
        .get<PasswordResetController>(AUTH_TYPES.PasswordResetController)
        .forgot(req, res, next);
    });

    this.router.post('/password/verify-otp', this.limiter.handle, (req, res, next) => {
      return req.container
        .get<PasswordResetController>(AUTH_TYPES.PasswordResetController)
        .verifyOtp(req, res, next);
    });

    this.router.post('/password/reset', this.limiter.handle, (req, res, next) => {
      return req.container
        .get<PasswordResetController>(AUTH_TYPES.PasswordResetController)
        .reset(req, res, next);
    });

    this.router.use(oauthRouter.router);
  }
}
