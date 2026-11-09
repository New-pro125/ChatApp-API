export class PasswordResetCodeRecord {
  constructor(
    readonly id: string,
    readonly userId: string,
    readonly codeHash: string,
    readonly expiresAt: Date,
    readonly attempts: number,
    readonly consumedAt: Date | null,
    readonly resetTokenHash: string | null,
    readonly tokenExpiresAt: Date | null,
    readonly tokenUsedAt: Date | null,
    readonly createdAt: Date,
  ) {}
}
