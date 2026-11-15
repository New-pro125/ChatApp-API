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
import type { UserRepository } from '@/modules/auth/logic/ports/user.repository.js';

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
    @inject(AUTH_TYPES.UserRepository) private readonly users: UserRepository,
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
   * active code waiting in its inbox.
   */
  async request(recipient: EmailVerificationRecipient, ip: string | null): Promise<void> {
    if (recipient.emailVerifiedAt) {
      throw new EmailAlreadyVerifiedException();
    }

    const lastCreatedAt = await this.codes.lastCreatedAt(recipient.id);

    if (lastCreatedAt) {
      const cooldownMs = this.config.verification.resendCooldownSeconds * 1000;
      const remainingMs = cooldownMs - (Date.now() - lastCreatedAt.getTime());

      if (remainingMs > 0) {
        throw new ResendCooldownException(Math.max(1, Math.ceil(remainingMs / 1000)));
      }
    }

    const code = this.tokens.generateOtp();
    const codeHash = await this.hasher.hash(code);
    const expiresAt = new Date(Date.now() + this.config.verification.ttlSeconds * 1000);

    await this.codes.invalidateActive(recipient.id);
    await this.codes.create({
      userId: recipient.id,
      codeHash,
      expiresAt,
      requestedIp: ip,
    });

    try {
      await this.email.sendVerificationCode(recipient.email, code, expiresAt);
    } catch (error) {
      this.logger.error(
        { err: error, userId: recipient.id },
        'Failed to send email verification code',
      );
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
      await this.codes.incrementAttempts(record.id);
      throw new OtpInvalidException('Invalid verification code');
    }

    await this.codes.markConsumed(record.id);
    await this.users.markEmailVerified(userId, new Date());
  }
}
