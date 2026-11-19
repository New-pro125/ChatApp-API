import { injectable } from 'inversify';

export interface PutPresignOptions {
  bucket: string;
  key: string;
  contentType: string;
  sizeBytes: number;
  expiresIn: number;
  headers: { 'Content-Type': string; 'Content-Length': string };
  expiresAt: Date;
}

export interface GetPresignOptions {
  bucket: string;
  key: string;
  expiresIn: number;
  expiresAt: Date;
}

/** Pure option construction so exact headers and TTLs can be unit tested offline. */
@injectable()
export class MediaPresignOptions {
  put(
    bucket: string,
    key: string,
    contentType: string,
    sizeBytes: number,
    expiresIn: number,
  ): PutPresignOptions {
    return {
      bucket,
      key,
      contentType,
      sizeBytes,
      expiresIn,
      headers: {
        'Content-Type': contentType,
        'Content-Length': String(sizeBytes),
      },
      expiresAt: new Date(Date.now() + expiresIn * 1_000),
    };
  }

  get(bucket: string, key: string, expiresIn: number): GetPresignOptions {
    return {
      bucket,
      key,
      expiresIn,
      expiresAt: new Date(Date.now() + expiresIn * 1_000),
    };
  }
}
