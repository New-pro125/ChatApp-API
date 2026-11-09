import 'express-session';
import type { SessionPrincipal } from '@/modules/auth/logic/entities/authenticated-user.js';

declare module 'express-session' {
  interface SessionData {
    passport?: {
      user?: SessionPrincipal;
    };

    returnTo?: string;

    mfaChallenge?: {
      token: string;
      expiresAt: string;
    } | null;

    oidc?: {
      state: string;
      codeVerifier: string;
    } | null;
  }
}
