import type { InferSelectModel } from 'drizzle-orm';
import { mediaObjects } from '@/core/database/schema/index.js';
import { MediaObjectRecord } from '@/modules/media/logic/entities/media-object-record.js';

export const mediaObjectSelection = {
  id: mediaObjects.id,
  ownerUserId: mediaObjects.ownerUserId,
  objectKey: mediaObjects.objectKey,
  versionId: mediaObjects.versionId,
  contentType: mediaObjects.contentType,
  sizeBytes: mediaObjects.sizeBytes,
  sha256: mediaObjects.sha256,
  status: mediaObjects.status,
  scanSignature: mediaObjects.scanSignature,
  scanError: mediaObjects.scanError,
  createdAt: mediaObjects.createdAt,
  updatedAt: mediaObjects.updatedAt,
  finalizedAt: mediaObjects.finalizedAt,
} as const;

export type MediaObjectRow = Pick<
  InferSelectModel<typeof mediaObjects>,
  keyof typeof mediaObjectSelection
>;

export class MediaObjectMapper {
  toRecord(row: MediaObjectRow): MediaObjectRecord {
    return new MediaObjectRecord(
      row.id,
      row.ownerUserId,
      row.objectKey,
      row.versionId,
      row.contentType,
      row.sizeBytes,
      row.sha256,
      row.status as MediaObjectRecord['status'],
      row.scanSignature,
      row.scanError,
      row.createdAt,
      row.updatedAt,
      row.finalizedAt,
    );
  }
}
