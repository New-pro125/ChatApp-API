import type { UserRecord } from '@/modules/auth/logic/entities/user-record.js';

export class AuthenticatedUser {
  constructor(
    readonly id: string,
    readonly email: string,
    readonly displayName: string,
    readonly createdAt: Date,
    readonly sessionVersion: number,
    readonly mfaEnabled: boolean,
    readonly mfaEnrolledAt: Date | null,
    readonly emailVerifiedAt: Date | null = null,
  ) {}

  get isEmailVerified(): boolean {
    return this.emailVerifiedAt !== null;
  }

  static fromRecord(record: UserRecord): AuthenticatedUser {
    return new AuthenticatedUser(
      record.id,
      record.email,
      record.displayName,
      record.createdAt,
      record.sessionVersion,
      record.mfaEnabled,
      record.mfaEnrolledAt,
      record.emailVerifiedAt,
    );
  }
}

export class SessionPrincipal {
  constructor(
    readonly id: string,
    readonly sessionVersion: number,
  ) {}
}
