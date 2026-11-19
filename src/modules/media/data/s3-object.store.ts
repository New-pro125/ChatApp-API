import type { Readable } from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { inject, injectable } from 'inversify';
import type { AppConfig } from '@/core/config/app.config.js';
import { CORE_TYPES } from '@/core/container/core.types.js';
import { ObjectStoreException } from '@/core/errors/repository.error.js';
import type { MediaPresignOptions } from '@/modules/media/logic/media-presign.options.js';
import type {
  ObjectMetadata,
  ObjectStore,
  PresignedDownload,
  PresignedUpload,
} from '@/modules/media/logic/ports/object-store.js';
import { MEDIA_TYPES } from '@/modules/media/media.types.js';

/** S3-compatible adapter; the bucket is private and all access is presigned. */
@injectable()
export class S3ObjectStore implements ObjectStore {
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly ttlSeconds: number;

  constructor(
    @inject(CORE_TYPES.Config) config: AppConfig,
    @inject(MEDIA_TYPES.MediaPresignOptions) private readonly options: MediaPresignOptions,
  ) {
    const media = config.media;
    this.bucket = media.bucket;
    this.ttlSeconds = media.presignTtlSeconds;
    this.client = new S3Client({
      region: media.region,
      endpoint: media.endpoint,
      forcePathStyle: media.forcePathStyle,
      credentials: {
        accessKeyId: media.accessKeyId,
        secretAccessKey: media.secretAccessKey,
      },
    });
  }

  async presignPut(
    objectKey: string,
    contentType: string,
    sizeBytes: number,
  ): Promise<PresignedUpload> {
    const options = this.options.put(
      this.bucket,
      objectKey,
      contentType,
      sizeBytes,
      this.ttlSeconds,
    );

    try {
      const command = new PutObjectCommand({
        Bucket: options.bucket,
        Key: options.key,
        ContentType: options.contentType,
        ContentLength: options.sizeBytes,
      });
      const url = await getSignedUrl(this.client, command, {
        expiresIn: options.expiresIn,
        signableHeaders: new Set(['content-type']),
      });

      return { url, headers: options.headers, expiresAt: options.expiresAt };
    } catch {
      throw new ObjectStoreException('Failed to presign an upload');
    }
  }

  async putStream(
    objectKey: string,
    contentType: string,
    sizeBytes: number,
    body: Readable,
  ): Promise<void> {
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: objectKey,
          Body: body,
          ContentType: contentType,
          ContentLength: sizeBytes,
        }),
      );
    } catch (error) {
      throw new ObjectStoreException('Failed to upload media object stream', { cause: error });
    }
  }

  async presignGet(objectKey: string, versionId: string | null): Promise<PresignedDownload> {
    const options = this.options.get(this.bucket, objectKey, this.ttlSeconds);

    try {
      const command = new GetObjectCommand({
        Bucket: options.bucket,
        Key: options.key,
        VersionId: versionId ?? undefined,
      });
      const url = await getSignedUrl(this.client, command, { expiresIn: options.expiresIn });

      return { url, expiresAt: options.expiresAt };
    } catch {
      throw new ObjectStoreException('Failed to presign a download');
    }
  }

  async head(objectKey: string): Promise<ObjectMetadata | null> {
    try {
      const result = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: objectKey }),
      );

      return {
        contentType: result.ContentType ?? '',
        sizeBytes: result.ContentLength ?? 0,
        versionId: result.VersionId ?? null,
      };
    } catch (error) {
      if (this.isMissingObject(error)) {
        return null;
      }

      throw new ObjectStoreException('Failed to inspect a media object');
    }
  }

  async getStream(objectKey: string, versionId: string | null): Promise<Readable> {
    try {
      const result = await this.client.send(
        new GetObjectCommand({
          Bucket: this.bucket,
          Key: objectKey,
          VersionId: versionId ?? undefined,
        }),
      );

      if (!result.Body) {
        throw new ObjectStoreException('Media object has no body');
      }

      return result.Body as unknown as Readable;
    } catch (error) {
      if (error instanceof ObjectStoreException) {
        throw error;
      }

      throw new ObjectStoreException('Failed to open a media object');
    }
  }

  async delete(objectKey: string): Promise<void> {
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: objectKey }));
    } catch {
      throw new ObjectStoreException('Failed to delete a media object');
    }
  }

  private isMissingObject(error: unknown): boolean {
    if (typeof error !== 'object' || error === null) {
      return false;
    }

    const candidate = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };

    return (
      candidate.name === 'NotFound' ||
      candidate.name === 'NoSuchKey' ||
      candidate.$metadata?.httpStatusCode === 404
    );
  }
}
