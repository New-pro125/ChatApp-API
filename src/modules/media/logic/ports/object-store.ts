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
}

export interface ObjectStore {
  presignPut(objectKey: string, contentType: string, sizeBytes: number): Promise<PresignedUpload>;
  presignGet(objectKey: string): Promise<PresignedDownload>;
  head(objectKey: string): Promise<ObjectMetadata | null>;
  getStream(objectKey: string): Promise<Readable>;
  delete(objectKey: string): Promise<void>;
}
