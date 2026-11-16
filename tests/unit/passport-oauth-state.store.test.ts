import type { Request } from 'express';
import { describe, expect, it } from 'vitest';
import type {
  OAuthStatePayload,
  OAuthStateStore,
} from '@/modules/auth/logic/ports/oauth-state.store.js';
import { PassportOAuthStateStore } from '@/modules/auth/web/passport/passport-oauth-state.store.js';

class RecordingStateStore implements OAuthStateStore {
  readonly saved: OAuthStatePayload[] = [];
  nextValue: OAuthStatePayload | null = null;

  save(_req: Request, payload: OAuthStatePayload): Promise<void> {
    this.saved.push(payload);
    return Promise.resolve();
  }

  consume(_req: Request): Promise<OAuthStatePayload | null> {
    return Promise.resolve(this.nextValue);
  }
}

function issueState(
  store: PassportOAuthStateStore,
  strategyState: string,
): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    store.store({} as Request, strategyState, undefined, (error, state) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(state);
    });
  });
}

function verifyState(
  store: PassportOAuthStateStore,
  providedState: string,
): Promise<{ valid: boolean | undefined; info: { message: string } | undefined }> {
  return new Promise((resolve, reject) => {
    store.verify({} as Request, providedState, undefined, (error, valid, info) => {
      if (error) {
        reject(error);
        return;
      }

      resolve({ valid, info });
    });
  });
}

describe('PassportOAuthStateStore', () => {
  it('issues a random nonce instead of persisting the strategy flag', async () => {
    const states = new RecordingStateStore();
    const store = new PassportOAuthStateStore(states);

    const issued = await issueState(store, true as unknown as string);

    expect(issued).toMatch(/^[A-Za-z0-9_-]{24,}$/);
    expect(issued).not.toBe('true');
    expect(states.saved).toEqual([{ state: issued }]);
  });

  it('issues a different nonce for every redirect', async () => {
    const store = new PassportOAuthStateStore(new RecordingStateStore());

    const first = await issueState(store, true as unknown as string);
    const second = await issueState(store, true as unknown as string);

    expect(first).not.toBe(second);
  });

  it('keeps an explicit string state when it is a usable nonce', async () => {
    const states = new RecordingStateStore();
    const store = new PassportOAuthStateStore(states);
    const explicit = 'explicit-state-value-123';

    const issued = await issueState(store, explicit);

    expect(issued).toBe(explicit);
    expect(states.saved).toEqual([{ state: explicit }]);
  });

  it('accepts a matching consumed state and rejects a mismatch', async () => {
    const states = new RecordingStateStore();
    const store = new PassportOAuthStateStore(states);

    states.nextValue = { state: 'expected-state' };
    await expect(verifyState(store, 'expected-state')).resolves.toEqual({
      valid: true,
      info: undefined,
    });

    states.nextValue = { state: 'expected-state' };
    const mismatch = await verifyState(store, 'attacker-state');
    expect(mismatch.valid).toBe(false);
    expect(mismatch.info?.message).toBe('Invalid authorization request state.');
  });

  it('rejects verification when no state was saved', async () => {
    const store = new PassportOAuthStateStore(new RecordingStateStore());

    const result = await verifyState(store, 'anything');

    expect(result.valid).toBe(false);
  });
});
