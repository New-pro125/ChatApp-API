import { inject, injectable } from 'inversify';
import type { Logger } from 'pino';
import type { AppConfig } from '@/core/config/app.config.js';
import { CORE_TYPES } from '@/core/container/core.types.js';
import type { EmailSender } from '@/modules/auth/logic/ports/email.sender.js';

@injectable()
export class LogEmailSender implements EmailSender {
  constructor(
    @inject(CORE_TYPES.Config) private readonly config: AppConfig,
    @inject(CORE_TYPES.Logger) private readonly logger: Logger,
  ) {}

  sendOtp(email: string, otp: string, expiresAt: Date): Promise<void> {
    this.logger.warn(
      {
        email,
        otp: this.config.nodeEnv === 'production' ? '[redacted]' : otp,
        expiresAt: expiresAt.toISOString(),
      },
      'SMTP is not configured; password reset OTP was not emailed',
    );

    return Promise.resolve();
  }

  sendVerificationCode(email: string, code: string, expiresAt: Date): Promise<void> {
    this.logger.warn(
      {
        email,
        code: this.config.nodeEnv === 'production' ? '[redacted]' : code,
        expiresAt: expiresAt.toISOString(),
      },
      'SMTP is not configured; email verification code was not emailed',
    );

    return Promise.resolve();
  }
}
