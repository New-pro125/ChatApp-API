import type { EmailVerificationCodeRecord } from '@/modules/auth/logic/entities/email-verification-code.js';

export interface IssueEmailVerificationCodeInput {
  userId: string;
  codeHash: string;
  ttlSeconds: number;
  cooldownSeconds: number;
  requestedIp: string | null;
}

export type IssueEmailVerificationCodeResult =
  | { issued: true; expiresAt: Date }
  | { issued: false; retryAfterSeconds: number };

export interface EmailVerificationRepository {
  /**
   * Atomically enforces the resend cooldown, consumes older active codes, and
   * inserts the new code. Cooldown math and expiry use the database clock.
   */
  issue(input: IssueEmailVerificationCodeInput): Promise<IssueEmailVerificationCodeResult>;
  findActive(userId: string): Promise<EmailVerificationCodeRecord | null>;
  /**
   * Increments the attempt counter only while the budget remains and reports
   * whether the increment was recorded.
   */
  incrementAttempts(id: string, maxAttempts: number): Promise<boolean>;
  /**
   * Consumes the code and marks the owner verified in one transaction. Returns
   * false when the code was already consumed or has expired.
   */
  consumeAndMarkVerified(id: string, userId: string, verifiedAt: Date): Promise<boolean>;
}
