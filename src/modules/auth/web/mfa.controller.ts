import type { Request, RequestHandler } from 'express';
import { inject, injectable } from 'inversify';
import type passport from 'passport';
import { CORE_TYPES } from '@/core/container/core.types.js';
import { MfaInvalidCodeException } from '@/core/errors/domain.error.js';
import { UnauthorizedException } from '@/core/errors/http.error.js';
import type { ApiResponse } from '@/core/http/response/api-response.js';
import { AUTH_TYPES } from '@/modules/auth/auth.types.js';
import type { AuthenticatedUser } from '@/modules/auth/logic/entities/authenticated-user.js';
import type { MfaService } from '@/modules/auth/logic/mfa.service.js';
import type { SessionManager } from '@/modules/auth/logic/session-manager.js';
import {
  confirmEnrollmentSchema,
  mfaCodeRequestSchema,
  verifyMfaSchema,
} from '@/modules/auth/web/dto/auth.schemas.js';

type PassportStatic = typeof passport;

@injectable()
export class MfaController {
  constructor(
    @inject(AUTH_TYPES.MfaService) private readonly mfa: MfaService,
    @inject(AUTH_TYPES.SessionManager) private readonly session: SessionManager,
    @inject(CORE_TYPES.Passport) private readonly passport: PassportStatic,
    @inject(CORE_TYPES.ApiResponse) private readonly response: ApiResponse,
  ) {}

  enroll: RequestHandler = async (req, res) => {
    const result = await this.mfa.startEnrollment(this.requireUser(req).id);

    this.response.ok(res, result, {
      message: 'Scan the authenticator URI and confirm with a generated code',
    });
  };

  confirmEnrollment: RequestHandler = async (req, res) => {
    const input = confirmEnrollmentSchema.parse(req.body);
    const result = await this.mfa.confirmEnrollment(this.requireUser(req).id, input.code);

    this.response.ok(res, result, {
      message: 'Two-factor authentication is enabled. Store the recovery codes securely.',
    });
  };

  status: RequestHandler = async (req, res) => {
    const status = await this.mfa.status(this.requireUser(req).id);

    this.response.ok(res, status);
  };

  disable: RequestHandler = async (req, res) => {
    const input = mfaCodeRequestSchema.parse(req.body);

    await this.mfa.disable(this.requireUser(req).id, input.code);

    this.response.noContent(res);
  };

  regenerateRecoveryCodes: RequestHandler = async (req, res) => {
    const input = mfaCodeRequestSchema.parse(req.body);
    const recoveryCodes = await this.mfa.regenerateRecoveryCodes(
      this.requireUser(req).id,
      input.code,
    );

    this.response.ok(
      res,
      { recoveryCodes },
      {
        message: 'Previous recovery codes have been replaced',
      },
    );
  };

  verify: RequestHandler = (req, res, next) => {
    const input = verifyMfaSchema.parse(req.body);
    req.body = input;

    this.passport.authenticate(
      'totp',
      { session: false },
      (error: unknown, user: Express.User | false | null | undefined) => {
        if (error) {
          next(error);
          return;
        }

        if (!user) {
          next(new MfaInvalidCodeException());
          return;
        }

        this.session
          .establish(req, user)
          .then(
            () => this.response.ok(res, user, { message: 'Two-factor authentication verified' }),
            next,
          );
      },
    )(req, res, next);
  };

  private requireUser(req: Request): AuthenticatedUser {
    if (!req.isAuthenticated()) {
      throw new UnauthorizedException();
    }

    return req.user;
  }
}
