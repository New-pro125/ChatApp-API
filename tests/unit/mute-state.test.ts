import { describe, expect, it } from 'vitest';
import { MuteState } from '@/modules/messages/logic/entities/mute-state.js';

describe('MuteState', () => {
  const now = new Date('2026-11-20T10:00:00.000Z');

  it('reports never-muted memberships as unmuted', () => {
    const state = MuteState.from({ mutedAt: null, mutedUntil: null }, now);
    expect(state.muted).toBe(false);
    expect(state.expiresAt).toBeNull();
  });

  it('reports a null expiry as active forever', () => {
    const state = MuteState.from(
      { mutedAt: new Date('2026-11-19T10:00:00.000Z'), mutedUntil: null },
      now,
    );
    expect(state.muted).toBe(true);
    expect(state.expiresAt).toBeNull();
  });

  it('reports a future expiry as active', () => {
    const expiresAt = new Date('2026-11-21T10:00:00.000Z');
    const state = MuteState.from({ mutedAt: now, mutedUntil: expiresAt }, now);
    expect(state.muted).toBe(true);
    expect(state.expiresAt).toEqual(expiresAt);
  });

  it('reports a past expiry as unmuted without exposing the stale date', () => {
    const state = MuteState.from(
      {
        mutedAt: new Date('2026-11-19T10:00:00.000Z'),
        mutedUntil: new Date('2026-11-20T09:00:00.000Z'),
      },
      now,
    );
    expect(state.muted).toBe(false);
    expect(state.expiresAt).toBeNull();
  });
});
