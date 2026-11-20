import type { SelfDestructPreset } from '@/modules/messages/logic/entities/self-destruct-preset.js';

/** Maps API presets to server-computed deadlines. */
export class SelfDestructTimer {
  static readonly seconds: Readonly<Record<SelfDestructPreset, number>> = {
    '24h': 86_400,
    '7d': 604_800,
    '90d': 7_776_000,
  };

  static expiryFor(preset: SelfDestructPreset | null, now: Date = new Date()): Date | null {
    return preset === null
      ? null
      : new Date(now.getTime() + SelfDestructTimer.seconds[preset] * 1000);
  }
}
