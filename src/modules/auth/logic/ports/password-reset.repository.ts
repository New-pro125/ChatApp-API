import type { PasswordResetCodeRecord } from '@/modules/auth/logic/entities/password-reset-code.js';

export interface CreatePasswordResetCodeInput {
  userId: string;
  codeHash: string;
  expiresAt: Date;
  requestedIp: string | null;
}

export interface PasswordResetRepository {
  lastCreatedAt(userId: string): Promise<Date | null>;
  invalidateActive(userId: string): Promise<void>;
  create(input: CreatePasswordResetCodeInput): Promise<void>;
  findActive(userId: string): Promise<PasswordResetCodeRecord | null>;
  incrementAttempts(id: string): Promise<void>;
  markOtpVerified(id: string, tokenHash: string, tokenExpiresAt: Date): Promise<void>;
  findByTokenHash(tokenHash: string): Promise<PasswordResetCodeRecord | null>;
  markTokenUsed(id: string): Promise<void>;
}
