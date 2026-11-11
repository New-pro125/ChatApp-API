import type { Request } from 'express';
import { inject, injectable } from 'inversify';
import type { StateStore } from 'passport-oauth2';
import { AUTH_TYPES } from '@/modules/auth/auth.types.js';
import type { OAuthStateStore } from '@/modules/auth/logic/ports/oauth-state.store.js';

type StateStoreCallback = (error?: Error | null, state?: string) => void;

type VerifyStateCallback = (
  error?: Error | null,
  valid?: boolean,
  info?: { message: string },
) => void;

/**
 * Adapts the Redis-backed OAuth state store to passport-oauth2's custom state
 * store contract, replacing the session-based store that passport ships
 * with by default.
 */
@injectable()
export class PassportOAuthStateStore {
  constructor(@inject(AUTH_TYPES.OAuthStateStore) private readonly states: OAuthStateStore) {}

  readonly store = (
    req: Request,
    state: string,
    _meta: unknown,
    callback: StateStoreCallback,
  ): void => {
    void this.states
      .save(req, { state })
      .then(() => callback(null, state))
      .catch((error: unknown) =>
        callback(error instanceof Error ? error : new Error(String(error))),
      );
  };

  readonly verify = (
    req: Request,
    providedState: string,
    _meta: unknown,
    callback: VerifyStateCallback,
  ): void => {
    void this.states
      .consume(req)
      .then((saved) => {
        if (saved === null || saved.state !== providedState) {
          callback(null, false, { message: 'Invalid authorization request state.' });
          return;
        }

        callback(null, true);
      })
      .catch((error: unknown) =>
        callback(error instanceof Error ? error : new Error(String(error))),
      );
  };

  /**
   * View of this store that satisfies the strategy option type.
   *
   * passport-oauth2 dispatches on the store's arity at runtime and calls
   * custom stores with `(req, state, meta, callback)`, but the bundled
   * `@types/passport-oauth2` only describes the session-backed default
   * store (2-3 argument signatures), which no 4-argument function can be
   * assigned to. The runtime contract is the authority, so the cast is
   * contained here and the public shape of the class stays honest.
   */
  asStateStore(): StateStore {
    return this as unknown as StateStore;
  }
}
