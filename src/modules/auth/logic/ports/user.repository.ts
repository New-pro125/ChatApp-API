import type { UserRecord } from '@/modules/auth/logic/entities/user-record.js';

export interface CreateUserInput {
  email: string;
  displayName: string;
  passwordHash: string | null;
  emailVerifiedAt?: Date | null;
}

export interface UpdateProfileInput {
  displayName?: string | undefined;
  username?: string | null | undefined;
  bio?: string | null | undefined;
  phone?: string | null | undefined;
}

export interface UserRepository {
  findById(id: string): Promise<UserRecord | null>;
  findByEmail(email: string): Promise<UserRecord | null>;
  create(input: CreateUserInput): Promise<UserRecord>;
  updateProfile(id: string, input: UpdateProfileInput): Promise<UserRecord | null>;
  updateLoginFailure(
    id: string,
    attempts: number,
    lastFailedAt: Date,
    lockedUntil: Date | null,
  ): Promise<void>;
  clearLoginFailures(id: string): Promise<void>;
  updatePassword(id: string, passwordHash: string): Promise<void>;
  markEmailVerified(id: string, verifiedAt: Date): Promise<void>;
  /** Bumps the session version, invalidating every outstanding access token. */
  updateSessionVersion(id: string): Promise<void>;
}
