import type {
  MfaChallengeRecord,
  MfaRecoveryCodeRecord,
} from '@/modules/auth/logic/entities/mfa-record.js';

export interface CreateMfaChallengeInput {
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  requestedIp: string | null;
}

export interface MfaRepository {
  invalidateChallenges(userId: string): Promise<void>;
  createChallenge(input: CreateMfaChallengeInput): Promise<void>;
  findChallengeByTokenHash(tokenHash: string): Promise<MfaChallengeRecord | null>;
  incrementChallengeAttempts(id: string): Promise<void>;
  consumeChallenge(id: string): Promise<boolean>;
  startEnrollment(userId: string, secretCiphertext: string, startedAt: Date): Promise<void>;
  activate(userId: string, enrolledAt: Date, recoveryCodeHashes: string[]): Promise<void>;
  disable(userId: string): Promise<void>;
  consumeTotpStep(userId: string, step: number): Promise<boolean>;
  findRecoveryCode(userId: string, codeHash: string): Promise<MfaRecoveryCodeRecord | null>;
  markRecoveryCodeUsed(id: string): Promise<boolean>;
  countUnusedRecoveryCodes(userId: string): Promise<number>;
  replaceRecoveryCodes(userId: string, codeHashes: string[]): Promise<void>;
}
