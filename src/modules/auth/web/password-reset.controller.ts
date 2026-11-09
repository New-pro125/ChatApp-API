import type { RequestHandler } from 'express';
import { inject, injectable } from 'inversify';
import { CORE_TYPES } from '@/core/container/core.types.js';
import type { ApiResponse } from '@/core/http/response/api-response.js';
import { AUTH_TYPES } from '@/modules/auth/auth.types.js';
import type { PasswordResetService } from '@/modules/auth/logic/password-reset.service.js';
import {
  forgotPasswordSchema,
  resetPasswordSchema,
  verifyOtpSchema,
} from '@/modules/auth/web/dto/auth.schemas.js';

@injectable()
export class PasswordResetController {
  constructor(
    @inject(AUTH_TYPES.PasswordResetService)
    private readonly passwordReset: PasswordResetService,
    @inject(CORE_TYPES.ApiResponse) private readonly response: ApiResponse,
  ) {}

  forgot: RequestHandler = async (req, res) => {
    const input = forgotPasswordSchema.parse(req.body);

    await this.passwordReset.request(input.email, req.ip ?? null);

    this.response.accepted(res, null, {
      message: 'If the email is registered, a reset code has been sent.',
    });
  };

  verifyOtp: RequestHandler = async (req, res) => {
    const input = verifyOtpSchema.parse(req.body);

    const result = await this.passwordReset.verifyOtp(input.email, input.otp);

    this.response.ok(res, result);
  };

  reset: RequestHandler = async (req, res) => {
    const input = resetPasswordSchema.parse(req.body);

    await this.passwordReset.reset(input.resetToken, input.newPassword);

    this.response.noContent(res);
  };
}
