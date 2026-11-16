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
    readonly username: string | null = null,
    readonly bio: string | null = null,
    readonly phone: string | null = null,
    readonly avatarKey: string | null = null,
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
      record.username,
      record.bio,
      record.phone,
      record.avatarKey,
    );
  }
}

export class SessionPrincipal {
  constructor(
    readonly id: string,
    readonly sessionVersion: number,
  ) {}
}
