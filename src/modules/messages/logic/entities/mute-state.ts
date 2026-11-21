export interface MuteMembership {
  readonly mutedAt: Date | null;
  readonly mutedUntil: Date | null;
}

export class MuteState {
  private constructor(
    readonly muted: boolean,
    readonly expiresAt: Date | null,
  ) {}

  static from(membership: MuteMembership, now: Date): MuteState {
    if (membership.mutedAt === null) {
      return new MuteState(false, null);
    }

    if (membership.mutedUntil === null) {
      return new MuteState(true, null);
    }

    if (membership.mutedUntil.getTime() <= now.getTime()) {
      return new MuteState(false, null);
    }

    return new MuteState(true, membership.mutedUntil);
  }
}
