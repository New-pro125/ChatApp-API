import { inject, injectable } from 'inversify';
import type { AppConfig } from '@/core/config/app.config.js';
import { CORE_TYPES } from '@/core/container/core.types.js';
import {
  MfaAlreadyEnabledException,
  MfaChallengeExpiredException,
  MfaDisabledException,
  MfaEnrollmentExpiredException,
  MfaInvalidCodeException,
  MfaNotEnabledException,
  MfaNotEnrolledException,
} from '@/core/errors/domain.error.js';
import { AUTH_TYPES } from '@/modules/auth/auth.types.js';
import type { TokenGenerator } from '@/modules/auth/data/token.generator.js';
import { AuthenticatedUser } from '@/modules/auth/logic/entities/authenticated-user.js';
import type { MfaChallengeRecord } from '@/modules/auth/logic/entities/mfa-record.js';
import type { UserRecord } from '@/modules/auth/logic/entities/user-record.js';
import type { MfaRepository } from '@/modules/auth/logic/ports/mfa.repository.js';
import type { MfaSecretCipher } from '@/modules/auth/logic/ports/mfa-secret.cipher.js';
import type { UserRepository } from '@/modules/auth/logic/ports/user.repository.js';
import type { TotpService } from '@/modules/auth/logic/totp.service.js';

const TOTP_CODE_PATTERN = /^\d{6}$/;

export interface MfaChallengeIssue {
  challengeToken: string;
  expiresAt: Date;
}

export interface MfaEnrollmentStart {
  secret: string;
  otpauthUrl: string;
  expiresAt: Date;
}

export interface MfaEnrollmentResult {
  recoveryCodes: string[];
}

export interface MfaStatus {
  available: boolean;
  enabled: boolean;
  enrolledAt: Date | null;
  recoveryCodesRemaining: number;
}

interface GeneratedRecoveryCodes {
  codes: string[];
  hashes: string[];
}

@injectable()
export class MfaService {
  constructor(
    @inject(AUTH_TYPES.UserRepository) private readonly users: UserRepository,
    @inject(AUTH_TYPES.MfaRepository) private readonly mfa: MfaRepository,
    @inject(AUTH_TYPES.MfaSecretCipher) private readonly cipher: MfaSecretCipher,
    @inject(AUTH_TYPES.TotpService) private readonly totp: TotpService,
    @inject(AUTH_TYPES.TokenGenerator) private readonly tokens: TokenGenerator,
    @inject(CORE_TYPES.Config) private readonly config: AppConfig,
  ) {}

  async startChallenge(
    userId: string,
    requestedIp: string | null = null,
  ): Promise<MfaChallengeIssue> {
    this.assertAvailable();

    const user = await this.requireUser(userId);

    if (!user.mfaEnabled) {
      throw new MfaNotEnabledException();
    }

    const challengeToken = this.tokens.generateMfaChallengeToken();
    const expiresAt = new Date(Date.now() + this.config.mfa.challengeTtlSeconds * 1000);

    await this.mfa.invalidateChallenges(user.id);
    await this.mfa.createChallenge({
      userId: user.id,
      tokenHash: this.tokens.hashMfaChallengeToken(challengeToken),
      expiresAt,
      requestedIp,
    });

    return { challengeToken, expiresAt };
  }

  async verifyChallenge(challengeToken: string, code: string): Promise<AuthenticatedUser> {
    this.assertAvailable();

    const challenge = await this.mfa.findChallengeByTokenHash(
      this.tokens.hashMfaChallengeToken(challengeToken),
    );

    this.assertChallengeUsable(challenge);

    const user = await this.requireUser(challenge.userId);

    if (!user.mfaEnabled) {
      throw new MfaChallengeExpiredException();
    }

    if (!(await this.verifyCode(user, code))) {
      await this.mfa.incrementChallengeAttempts(challenge.id);
      throw new MfaInvalidCodeException();
    }

    if (!(await this.mfa.consumeChallenge(challenge.id))) {
      throw new MfaChallengeExpiredException();
    }

    return AuthenticatedUser.fromRecord(user);
  }

  async startEnrollment(userId: string): Promise<MfaEnrollmentStart> {
    this.assertAvailable();

    const user = await this.requireUser(userId);

    if (user.mfaEnabled) {
      throw new MfaAlreadyEnabledException();
    }

    const secret = this.totp.generateSecret();
    const startedAt = new Date();
    const expiresAt = new Date(startedAt.getTime() + this.config.mfa.enrollmentTtlSeconds * 1000);

    await this.mfa.startEnrollment(user.id, this.cipher.encrypt(secret), startedAt);

    return {
      secret,
      otpauthUrl: this.totp.createKeyUri(user.email, secret),
      expiresAt,
    };
  }

  async confirmEnrollment(userId: string, code: string): Promise<MfaEnrollmentResult> {
    this.assertAvailable();

    const user = await this.requireUser(userId);

    if (user.mfaEnabled) {
      throw new MfaAlreadyEnabledException();
    }

    const secret = this.requireEnrollmentSecret(user);

    this.assertEnrollmentNotExpired(user);

    const step = this.totp.validate(secret, code);

    if (step === null || !(await this.mfa.consumeTotpStep(user.id, step))) {
      throw new MfaInvalidCodeException();
    }

    const recoveryCodes = this.generateRecoveryCodes();

    await this.mfa.activate(user.id, new Date(), recoveryCodes.hashes);

    return { recoveryCodes: recoveryCodes.codes };
  }

  async disable(userId: string, code: string): Promise<void> {
    this.assertAvailable();

    const user = await this.requireUser(userId);

    if (!user.mfaEnabled) {
      throw new MfaNotEnabledException();
    }

    if (!(await this.verifyTotpCode(user, code))) {
      throw new MfaInvalidCodeException();
    }

    await this.mfa.disable(user.id);
  }

  async regenerateRecoveryCodes(userId: string, code: string): Promise<string[]> {
    this.assertAvailable();

    const user = await this.requireUser(userId);

    if (!user.mfaEnabled) {
      throw new MfaNotEnabledException();
    }

    if (!(await this.verifyTotpCode(user, code))) {
      throw new MfaInvalidCodeException();
    }

    const recoveryCodes = this.generateRecoveryCodes();

    await this.mfa.replaceRecoveryCodes(user.id, recoveryCodes.hashes);

    return recoveryCodes.codes;
  }

  isAvailable(): boolean {
    return this.config.mfa.enabled;
  }

  async status(userId: string): Promise<MfaStatus> {
    const user = await this.requireUser(userId);
    const available = this.isAvailable();

    return {
      available,
      enabled: user.mfaEnabled,
      enrolledAt: user.mfaEnrolledAt,
      recoveryCodesRemaining: available ? await this.mfa.countUnusedRecoveryCodes(user.id) : 0,
    };
  }

  private async verifyCode(user: UserRecord, code: string): Promise<boolean> {
    if (!user.mfaEnabled) {
      throw new MfaNotEnabledException();
    }

    const normalized = code.trim();

    if (TOTP_CODE_PATTERN.test(normalized)) {
      const step = this.totp.validate(this.requireSecret(user), normalized);

      return step !== null && (await this.mfa.consumeTotpStep(user.id, step));
    }

    const recoveryCode = await this.mfa.findRecoveryCode(
      user.id,
      this.tokens.hashRecoveryCode(normalized),
    );

    return recoveryCode !== null && (await this.mfa.markRecoveryCodeUsed(recoveryCode.id));
  }

  private async verifyTotpCode(user: UserRecord, code: string): Promise<boolean> {
    const normalized = code.trim();

    if (!TOTP_CODE_PATTERN.test(normalized)) {
      return false;
    }

    const step = this.totp.validate(this.requireSecret(user), normalized);

    return step !== null && (await this.mfa.consumeTotpStep(user.id, step));
  }

  private requireSecret(user: UserRecord): string {
    if (!user.mfaSecretCiphertext) {
      throw new MfaNotEnrolledException();
    }

    return this.cipher.decrypt(user.mfaSecretCiphertext);
  }

  private requireEnrollmentSecret(user: UserRecord): string {
    if (!(user.mfaSecretCiphertext && user.mfaEnrollmentStartedAt)) {
      throw new MfaNotEnrolledException();
    }

    return this.cipher.decrypt(user.mfaSecretCiphertext);
  }

  private assertEnrollmentNotExpired(user: UserRecord): void {
    if (
      !user.mfaEnrollmentStartedAt ||
      user.mfaEnrollmentStartedAt.getTime() + this.config.mfa.enrollmentTtlSeconds * 1000 <=
        Date.now()
    ) {
      throw new MfaEnrollmentExpiredException();
    }
  }

  private assertChallengeUsable(
    challenge: MfaChallengeRecord | null,
  ): asserts challenge is MfaChallengeRecord {
    if (
      !challenge ||
      challenge.consumedAt !== null ||
      challenge.expiresAt.getTime() <= Date.now()
    ) {
      throw new MfaChallengeExpiredException();
    }

    if (challenge.attempts >= this.config.mfa.challengeMaxAttempts) {
      throw new MfaChallengeExpiredException('Too many invalid two-factor authentication attempts');
    }
  }

  private async requireUser(userId: string): Promise<UserRecord> {
    const user = await this.users.findById(userId);

    if (!user) {
      throw new MfaNotEnrolledException('The account is not available');
    }

    return user;
  }

  private assertAvailable(): void {
    if (!this.config.mfa.enabled) {
      throw new MfaDisabledException();
    }
  }

  private generateRecoveryCodes(): GeneratedRecoveryCodes {
    const codes: string[] = [];
    const hashes: string[] = [];

    for (let index = 0; index < this.config.mfa.recoveryCodeCount; index += 1) {
      const code = this.tokens.generateRecoveryCode();

      codes.push(code);
      hashes.push(this.tokens.hashRecoveryCode(code));
    }

    return { codes, hashes };
  }
}
