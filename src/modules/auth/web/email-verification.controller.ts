import type { Request, RequestHandler } from 'express';
import { inject, injectable } from 'inversify';
import { CORE_TYPES } from '@/core/container/core.types.js';
import { UnauthorizedException } from '@/core/errors/http.error.js';
import type { ApiResponse } from '@/core/http/response/api-response.js';
import { AUTH_TYPES } from '@/modules/auth/auth.types.js';
import type { EmailVerificationService } from '@/modules/auth/logic/email-verification.service.js';
import type { AuthenticatedUser } from '@/modules/auth/logic/entities/authenticated-user.js';
import { verifyEmailSchema } from '@/modules/auth/web/dto/auth.schemas.js';

@injectable()
export class EmailVerificationController {
  constructor(
    @inject(AUTH_TYPES.EmailVerificationService)
    private readonly verification: EmailVerificationService,
    @inject(CORE_TYPES.ApiResponse) private readonly response: ApiResponse,
  ) {}

  resend: RequestHandler = async (req, res) => {
    const user = this.requireUser(req);

    const delivered = await this.verification.request(user, req.ip ?? null);

    this.response.accepted(res, null, {
      message: delivered
        ? 'A verification code has been sent to your email address.'
        : 'A verification code was created but could not be delivered. Try resending shortly.',
    });
  };

  verify: RequestHandler = async (req, res) => {
    const user = this.requireUser(req);
    const input = verifyEmailSchema.parse(req.body);

    await this.verification.verify(user.id, input.code);

    this.response.noContent(res);
  };

  private requireUser(req: Request): AuthenticatedUser {
    if (!req.isAuthenticated()) {
      throw new UnauthorizedException();
    }

    return req.user;
  }
}
