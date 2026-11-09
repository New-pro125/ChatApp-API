export class MfaChallengeRecord {
  constructor(
    readonly id: string,
    readonly userId: string,
    readonly expiresAt: Date,
    readonly attempts: number,
    readonly consumedAt: Date | null,
    readonly createdAt: Date,
  ) {}
}

export class MfaRecoveryCodeRecord {
  constructor(
    readonly id: string,
    readonly userId: string,
    readonly usedAt: Date | null,
    readonly createdAt: Date,
  ) {}
}
