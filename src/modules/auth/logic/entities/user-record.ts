export class UserRecord {
  constructor(
    readonly id: string,
    readonly email: string,
    readonly displayName: string,
    readonly passwordHash: string | null,
    readonly emailVerifiedAt: Date | null,
    readonly failedLoginAttempts: number,
    readonly lockedUntil: Date | null,
    readonly lastFailedLoginAt: Date | null,
    readonly sessionVersion: number,
    readonly mfaEnabled: boolean,
    readonly mfaSecretCiphertext: string | null,
    readonly mfaEnrollmentStartedAt: Date | null,
    readonly mfaEnrolledAt: Date | null,
    readonly mfaLastTotpStep: number | null,
    readonly createdAt: Date,
  ) {}
}
