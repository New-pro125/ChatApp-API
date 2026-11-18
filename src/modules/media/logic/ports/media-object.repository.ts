import type { MediaObjectRecord } from '@/modules/media/logic/entities/media-object-record.js';

export interface CreateMediaObjectInput {
  ownerUserId: string;
  contentType: string;
  sizeBytes: number;
}

export interface MediaObjectRepository {
  create(input: CreateMediaObjectInput): Promise<MediaObjectRecord>;
  findOwned(id: string, ownerUserId: string): Promise<MediaObjectRecord | null>;
  transitionToReady(
    id: string,
    ownerUserId: string,
    sha256: string | null,
    versionId: string | null,
  ): Promise<MediaObjectRecord | null>;
  transitionToQuarantined(
    id: string,
    ownerUserId: string,
    signature: string,
    error: string | null,
    versionId: string | null,
  ): Promise<MediaObjectRecord | null>;
  markFailed(
    id: string,
    ownerUserId: string,
    error: string,
    versionId: string | null,
  ): Promise<MediaObjectRecord | null>;
  deleteOwned(id: string, ownerUserId: string): Promise<boolean>;
}
