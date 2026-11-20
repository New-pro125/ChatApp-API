export const SELF_DESTRUCT_PRESETS = ['24h', '7d', '90d'] as const;

export type SelfDestructPreset = (typeof SELF_DESTRUCT_PRESETS)[number];
