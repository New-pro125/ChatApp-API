import type { Request } from 'express';

export interface OAuthStatePayload {
  state: string;
  codeVerifier?: string;
}

/**
 * Persists OAuth redirect-flow state (CSRF state and PKCE verifiers) between
 * the outbound redirect and the provider callback.
 *
 * Sessions are not used for authentication, so the state lives in Redis
 * behind an opaque, httpOnly cookie that only exists for the duration of the
 * redirect handshake.
 */
export interface OAuthStateStore {
  save(req: Request, payload: OAuthStatePayload): Promise<void>;
  consume(req: Request): Promise<OAuthStatePayload | null>;
}
