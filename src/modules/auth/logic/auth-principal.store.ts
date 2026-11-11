import { inject, injectable } from 'inversify';
import type { Principal, PrincipalStore } from '@/core/auth/principal.store.js';
import { AUTH_TYPES } from '@/modules/auth/auth.types.js';
import type { AuthService } from '@/modules/auth/logic/auth.service.js';

/**
 * Resolves access-token principals against the current user record.
 *
 * The auth module publishes this implementation into the root container so
 * every module can authenticate requests without importing the auth module.
 */
@injectable()
export class AuthPrincipalStore implements PrincipalStore {
  constructor(@inject(AUTH_TYPES.AuthService) private readonly auth: AuthService) {}

  resolve(userId: string, sessionVersion: number): Promise<Principal | null> {
    return this.auth.findSessionUser(userId, sessionVersion);
  }
}
