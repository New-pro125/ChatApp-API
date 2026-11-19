import type { Readable } from 'node:stream';

/** A scanned, ready object that may be attached to a cloud message. */
export interface MediaAsset {
  readonly id: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly sha256: string | null;
}

/** A bounded incoming stream whose exact byte count is verified before use. */
export interface IncomingMediaUpload {
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly body: Readable;
  assertComplete(): Promise<void>;
}

/** Short-lived signed download details for a chat-authorized reader. */
export interface MediaDownload {
  readonly url: string;
  readonly expiresAt: Date;
  readonly contentType: string;
  readonly sizeBytes: number;
}

/** The only media operations other modules may call. */
export interface MediaAccess {
  requireReadyOwned(mediaId: string, userId: string): Promise<MediaAsset>;
  storeAndScan(userId: string, input: IncomingMediaUpload): Promise<MediaAsset>;
  signDownload(mediaId: string): Promise<MediaDownload>;
  releaseIfUnreferenced(mediaId: string): Promise<void>;
  assertDeletable(mediaId: string): Promise<void>;
}
