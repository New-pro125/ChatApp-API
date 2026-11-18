export const MEDIA_STATUSES = ['pending', 'ready', 'quarantined', 'failed'] as const;
export type MediaStatus = (typeof MEDIA_STATUSES)[number];

/** A server-owned upload lifecycle record. Drizzle types never cross this boundary. */
export class MediaObjectRecord {
  constructor(
    readonly id: string,
    readonly ownerUserId: string,
    readonly objectKey: string,
    readonly contentType: string,
    readonly sizeBytes: number,
    readonly sha256: string | null,
    readonly status: MediaStatus,
    readonly scanSignature: string | null,
    readonly scanError: string | null,
    readonly createdAt: Date,
    readonly updatedAt: Date,
    readonly finalizedAt: Date | null,
  ) {}
}
