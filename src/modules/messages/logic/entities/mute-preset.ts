export const MUTE_PRESETS = ['8h', '7d', 'forever'] as const;

export type MutePresetValue = (typeof MUTE_PRESETS)[number];

export interface MuteExpiry {
  readonly mutedAt: Date;
  readonly mutedUntil: Date | null;
}

const DURATION_MS: Record<Exclude<MutePresetValue, 'forever'>, number> = {
  '8h': 8 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
};

export class MutePreset {
  static readonly values = MUTE_PRESETS;

  private constructor(private readonly value: MutePresetValue) {}

  static resolve(preset: MutePresetValue, now: Date): MuteExpiry {
    return new MutePreset(preset).resolve(now);
  }

  private resolve(now: Date): MuteExpiry {
    if (this.value === 'forever') {
      return { mutedAt: now, mutedUntil: null };
    }

    return { mutedAt: now, mutedUntil: new Date(now.getTime() + DURATION_MS[this.value]) };
  }
}
