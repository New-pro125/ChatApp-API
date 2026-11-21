import { describe, expect, it } from 'vitest';
import { MutePreset } from '@/modules/messages/logic/entities/mute-preset.js';

describe('MutePreset', () => {
  const now = new Date('2026-11-20T10:00:00.000Z');

  it('maps 8h to an expiry eight hours later', () => {
    expect(MutePreset.resolve('8h', now)).toEqual({
      mutedAt: now,
      mutedUntil: new Date('2026-11-20T18:00:00.000Z'),
    });
  });

  it('maps 7d to an expiry seven days later', () => {
    expect(MutePreset.resolve('7d', now)).toEqual({
      mutedAt: now,
      mutedUntil: new Date('2026-11-27T10:00:00.000Z'),
    });
  });

  it('maps forever to a null expiry', () => {
    expect(MutePreset.resolve('forever', now)).toEqual({ mutedAt: now, mutedUntil: null });
  });
});
