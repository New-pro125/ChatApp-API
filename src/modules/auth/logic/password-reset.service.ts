import { inject, injectable } from 'inversify';
import type { Logger } from 'pino';
import type { AppConfig } from '@/core/config/app.config.js';
import { CORE_TYPES } from '@/core/container/core.types.js';
import { OtpExpiredException, OtpInvalidException } from '@/core/errors/domain.error.js';
import { AUTH_TYPES, type VerifyOtpResult } from '@/modules/auth/auth.types.js';
import type { TokenGenerator } from '@/modules/auth/data/token.generator.js';
import type { PasswordResetCodeRecord } from '@/modules/auth/logic/entities/password-reset-code.js';
import type { EmailSender } from '@/modules/auth/logic/ports/email.sender.js';
import type { PasswordHasher } from '@/modules/auth/logic/ports/password.hasher.js';
import type { PasswordResetRepository } from '@/modules/auth/logic/ports/password-reset.repository.js';
import type { UserRepository } from '@/modules/auth/logic/ports/user.repository.js';

@injectable()
export class PasswordResetService {
  constructor(
    @inject(AUTH_TYPES.UserRepository) private readonly users: UserRepository,
    @inject(AUTH_TYPES.PasswordResetRepository)
    private readonly codes: PasswordResetRepository,
    @inject(AUTH_TYPES.PasswordHasher) private readonly hasher: PasswordHasher,
    @inject(AUTH_TYPES.TokenGenerator) private readonly tokens: TokenGenerator,
    @inject(AUTH_TYPES.EmailSender) private readonly email: EmailSender,
    @inject(CORE_TYPES.Config) private readonly config: AppConfig,
    @inject(CORE_TYPES.Logger) private readonly logger: Logger,
  ) {}

  async request(email: string, ip: string | null): Promise<void> {
    const user = await this.users.findByEmail(email.trim().toLowerCase());

    if (!user) {
      return;
    }

    const lastCreatedAt = await this.codes.lastCreatedAt(user.id);

    if (
      lastCreatedAt &&
      Date.now() - lastCreatedAt.getTime() < this.config.otp.resendCooldownSeconds * 1000
    ) {
      return;
    }

    const otp = this.tokens.generateOtp();
    const codeHash = await this.hasher.hash(otp);
    const expiresAt = new Date(Date.now() + this.config.otp.ttlSeconds * 1000);

    await this.codes.invalidateActive(user.id);
    await this.codes.create({
      userId: user.id,
      codeHash,
      expiresAt,
      requestedIp: ip,
    });

    try {
      await this.email.sendOtp(user.email, otp, expiresAt);
    } catch (error) {
      this.logger.error({ err: error, userId: user.id }, 'Failed to send password reset OTP');
    }
  }

  async verifyOtp(email: string, otp: string): Promise<VerifyOtpResult> {
    const user = await this.users.findByEmail(email.trim().toLowerCase());

    if (!user) {
      throw new OtpInvalidException();
    }

    const code = await this.codes.findActive(user.id);

    if (!code) {
      throw new OtpExpiredException();
    }

    if (code.attempts >= this.config.otp.maxAttempts) {
      throw new OtpInvalidException('Too many invalid reset code attempts');
    }

    const valid = await this.hasher.verify(code.codeHash, otp);

    if (!valid) {
      await this.codes.incrementAttempts(code.id);
      throw new OtpInvalidException();
    }

    const resetToken = this.tokens.generateResetToken();
    const tokenExpiresAt = new Date(Date.now() + this.config.otp.resetTokenTtlSeconds * 1000);

    await this.codes.markOtpVerified(
      code.id,
      this.tokens.hashResetToken(resetToken),
      tokenExpiresAt,
    );

    return { resetToken, expiresAt: tokenExpiresAt };
  }

  async reset(token: string, newPassword: string): Promise<void> {
    const code = await this.codes.findByTokenHash(this.tokens.hashResetToken(token));

    this.assertResetTokenValid(code);

    const passwordHash = await this.hasher.hash(newPassword);

    await this.users.updatePassword(code.userId, passwordHash);
    await this.codes.markTokenUsed(code.id);
  }

  private assertResetTokenValid(
    code: PasswordResetCodeRecord | null,
  ): asserts code is PasswordResetCodeRecord {
    if (
      !code ||
      code.tokenUsedAt !== null ||
      code.tokenExpiresAt === null ||
      code.tokenExpiresAt.getTime() <= Date.now()
    ) {
      throw new OtpExpiredException('Reset token is invalid or expired');
    }
  }
}
