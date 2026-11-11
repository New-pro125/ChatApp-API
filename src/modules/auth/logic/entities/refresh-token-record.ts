export type RefreshTokenRevocationReason =
  | 'logout'
  | 'logout_all'
  | 'password_reset'
  | 'reuse_detected'
  | 'revoked_session';

export class RefreshTokenRecord {
  constructor(
    readonly id: string,
    readonly userId: string,
    readonly familyId: string,
    readonly tokenHash: string,
    readonly deviceName: string | null,
    readonly deviceType: string | null,
    readonly clientIp: string | null,
    readonly userAgent: string | null,
    readonly expiresAt: Date,
    readonly lastUsedAt: Date | null,
    readonly rotatedAt: Date | null,
    readonly revokedAt: Date | null,
    readonly revokedReason: string | null,
    readonly createdAt: Date,
  ) {}

  get isActive(): boolean {
    return (
      this.rotatedAt === null && this.revokedAt === null && this.expiresAt.getTime() > Date.now()
    );
  }
}

export class ActiveSessionRecord {
  constructor(
    readonly id: string,
    readonly deviceName: string | null,
    readonly deviceType: string | null,
    readonly clientIp: string | null,
    readonly userAgent: string | null,
    readonly createdAt: Date,
    readonly lastUsedAt: Date | null,
    readonly expiresAt: Date,
  ) {}
}

export interface DeviceContext {
  deviceName?: string | undefined;
  deviceType?: string | undefined;
  clientIp: string | null;
  userAgent: string | null;
}
