import { inject, injectable } from 'inversify';
import { createTransport, type Transporter } from 'nodemailer';
import type { Logger } from 'pino';
import type { AppConfig } from '@/core/config/app.config.js';
import { CORE_TYPES } from '@/core/container/core.types.js';
import type { EmailSender } from '@/modules/auth/logic/ports/email.sender.js';

@injectable()
export class SmtpEmailSender implements EmailSender {
  private readonly transporter: Transporter;

  constructor(
    @inject(CORE_TYPES.Config) private readonly config: AppConfig,
    @inject(CORE_TYPES.Logger) private readonly logger: Logger,
  ) {
    this.transporter = createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      auth:
        config.smtp.user && config.smtp.pass
          ? { user: config.smtp.user, pass: config.smtp.pass }
          : undefined,
    });
  }

  async sendOtp(email: string, otp: string, expiresAt: Date): Promise<void> {
    await this.transporter.sendMail({
      from: this.config.smtp.from,
      to: email,
      subject: 'Your password reset code',
      text: [
        `Your password reset code is: ${otp}`,
        '',
        `It expires at ${expiresAt.toISOString()}.`,
        'If you did not request a password reset, you can ignore this email.',
      ].join('\n'),
    });

    this.logger.info({ email }, 'Password reset OTP sent');
  }
}
