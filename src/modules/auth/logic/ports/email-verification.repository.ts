import type { EmailVerificationCodeRecord } from '@/modules/auth/logic/entities/email-verification-code.js';

export interface CreateEmailVerificationCodeInput {
  userId: string;
  codeHash: string;
  expiresAt: Date;
  requestedIp: string | null;
}

export interface EmailVerificationRepository {
  create(input: CreateEmailVerificationCodeInput): Promise<void>;
  findActive(userId: string): Promise<EmailVerificationCodeRecord | null>;
  lastCreatedAt(userId: string): Promise<Date | null>;
  incrementAttempts(id: string): Promise<void>;
  markConsumed(id: string): Promise<void>;
  invalidateActive(userId: string): Promise<void>;
}
