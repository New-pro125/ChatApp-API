import type { AuthenticatedUser } from '@/modules/auth/logic/entities/authenticated-user.js';

export interface AuthenticationSuccess {
  status: 'authenticated';
  user: AuthenticatedUser;
}

export interface MfaRequiredResult {
  status: 'mfa_required';
  challengeToken: string;
  expiresAt: Date;
}

export type AuthenticationResult = AuthenticationSuccess | MfaRequiredResult;
