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
  ) {}

  static fromRecord(record: UserRecord): AuthenticatedUser {
    return new AuthenticatedUser(
      record.id,
      record.email,
      record.displayName,
      record.createdAt,
      record.sessionVersion,
      record.mfaEnabled,
      record.mfaEnrolledAt,
    );
  }
}

export class SessionPrincipal {
  constructor(
    readonly id: string,
    readonly sessionVersion: number,
  ) {}
}
