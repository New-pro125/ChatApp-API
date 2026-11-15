import { inject, injectable } from 'inversify';
import type { Logger } from 'pino';
import type { AppConfig } from '@/core/config/app.config.js';
import { CORE_TYPES } from '@/core/container/core.types.js';
import {
  EmailAlreadyVerifiedException,
  OtpExpiredException,
  OtpInvalidException,
  ResendCooldownException,
} from '@/core/errors/domain.error.js';
import { AUTH_TYPES } from '@/modules/auth/auth.types.js';
import type { TokenGenerator } from '@/modules/auth/data/token.generator.js';
import type { EmailSender } from '@/modules/auth/logic/ports/email.sender.js';
import type { EmailVerificationRepository } from '@/modules/auth/logic/ports/email-verification.repository.js';
import type { PasswordHasher } from '@/modules/auth/logic/ports/password.hasher.js';

/** The subset of the authenticated user needed to issue a verification code. */
export interface EmailVerificationRecipient {
  id: string;
  email: string;
  emailVerifiedAt: Date | null;
}

/**
 * Issues and consumes email-verification codes.
 *
 * Codes are generated with a cryptographically secure RNG, stored only as
 * Argon2 hashes, expire after the configured TTL, and are attempt-limited so a
 * stolen code cannot be brute-forced. Issuing a new code invalidates every
 * older active code for the same user.
 */
@injectable()
export class EmailVerificationService {
  constructor(
    @inject(AUTH_TYPES.EmailVerificationRepository)
    private readonly codes: EmailVerificationRepository,
    @inject(AUTH_TYPES.PasswordHasher) private readonly hasher: PasswordHasher,
    @inject(AUTH_TYPES.TokenGenerator) private readonly tokens: TokenGenerator,
    @inject(AUTH_TYPES.EmailSender) private readonly email: EmailSender,
    @inject(CORE_TYPES.Config) private readonly config: AppConfig,
    @inject(CORE_TYPES.Logger) private readonly logger: Logger,
  ) {}

  /**
   * Sends a fresh verification code after enforcing the resend cooldown.
   *
   * Registration calls this as well, so a newly created account always has an
   * active code waiting in its inbox. The boolean reports whether the email
   * was handed to the transport; registration ignores it.
   */
  async request(recipient: EmailVerificationRecipient, ip: string | null): Promise<boolean> {
    if (recipient.emailVerifiedAt) {
      throw new EmailAlreadyVerifiedException();
    }

    const code = this.tokens.generateOtp();
    const codeHash = await this.hasher.hash(code);

    const result = await this.codes.issue({
      userId: recipient.id,
      codeHash,
      ttlSeconds: this.config.verification.ttlSeconds,
      cooldownSeconds: this.config.verification.resendCooldownSeconds,
      requestedIp: ip,
    });

    if (!result.issued) {
      throw new ResendCooldownException(result.retryAfterSeconds);
    }

    try {
      await this.email.sendVerificationCode(recipient.email, code, result.expiresAt);
      return true;
    } catch (error) {
      this.logger.error(
        { err: error, userId: recipient.id },
        'Failed to send email verification code',
      );

      return false;
    }
  }

  /**
   * Consumes the active code and marks the user's email verified.
   *
   * A missing active code, an exhausted attempt budget, and a hash mismatch all
   * surface as OTP errors so callers cannot distinguish "expired" from
   * "guessed wrong" beyond the public code.
   */
  async verify(userId: string, code: string): Promise<void> {
    const record = await this.codes.findActive(userId);

    if (!record) {
      throw new OtpExpiredException('Verification code has expired or does not exist');
    }

    if (record.attempts >= this.config.verification.maxAttempts) {
      throw new OtpInvalidException('Too many invalid verification code attempts');
    }

    const valid = await this.hasher.verify(record.codeHash, code);

    if (!valid) {
      const recorded = await this.codes.incrementAttempts(
        record.id,
        this.config.verification.maxAttempts,
      );

      if (!recorded) {
        throw new OtpInvalidException('Too many invalid verification code attempts');
      }

      throw new OtpInvalidException('Invalid verification code');
    }

    const consumed = await this.codes.consumeAndMarkVerified(record.id, userId, new Date());

    if (!consumed) {
      throw new OtpExpiredException('Verification code has already been used or has expired');
    }
  }
}
