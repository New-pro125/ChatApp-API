import type { Readable } from 'node:stream';

export interface PresignedUpload {
  url: string;
  headers: { 'Content-Type': string; 'Content-Length': string };
  expiresAt: Date;
}

export interface PresignedDownload {
  url: string;
  expiresAt: Date;
}

export interface ObjectMetadata {
  contentType: string;
  sizeBytes: number;
  /** Null when the bucket does not provide object versioning. */
  versionId: string | null;
}

export interface ObjectStore {
  presignPut(objectKey: string, contentType: string, sizeBytes: number): Promise<PresignedUpload>;
  putStream(
    objectKey: string,
    contentType: string,
    sizeBytes: number,
    body: Readable,
  ): Promise<void>;
  /** A null version id omits the VersionId query parameter for versionless buckets. */
  presignGet(objectKey: string, versionId: string | null): Promise<PresignedDownload>;
  head(objectKey: string): Promise<ObjectMetadata | null>;
  /** A null version id omits VersionId for versionless buckets. */
  getStream(objectKey: string, versionId: string | null): Promise<Readable>;
  delete(objectKey: string): Promise<void>;
}
