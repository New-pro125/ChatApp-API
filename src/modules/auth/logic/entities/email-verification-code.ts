export class EmailVerificationCodeRecord {
  constructor(
    readonly id: string,
    readonly userId: string,
    readonly codeHash: string,
    readonly expiresAt: Date,
    readonly attempts: number,
    readonly consumedAt: Date | null,
    readonly requestedIp: string | null,
    readonly createdAt: Date,
  ) {}
}
