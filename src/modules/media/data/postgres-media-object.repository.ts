import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { inject, injectable } from 'inversify';
import { CORE_TYPES } from '@/core/container/core.types.js';
import type { AppDatabase } from '@/core/database/database.provider.js';
import { mediaObjects } from '@/core/database/schema/index.js';
import { PersistenceException } from '@/core/errors/repository.error.js';
import {
  MediaObjectMapper,
  mediaObjectSelection,
} from '@/modules/media/data/media-object.mapper.js';
import type { MediaObjectRecord } from '@/modules/media/logic/entities/media-object-record.js';
import type { MediaObjectKeyFactory } from '@/modules/media/logic/media-object-key.factory.js';
import type {
  CreateMediaObjectInput,
  MediaObjectRepository,
} from '@/modules/media/logic/ports/media-object.repository.js';
import { MEDIA_TYPES } from '@/modules/media/media.types.js';

/** Drizzle persistence for media upload lifecycle records. */
@injectable()
export class PostgresMediaObjectRepository implements MediaObjectRepository {
  private readonly mapper = new MediaObjectMapper();

  constructor(
    @inject(CORE_TYPES.Db) private readonly db: AppDatabase,
    @inject(MEDIA_TYPES.MediaObjectKeyFactory)
    private readonly keys: MediaObjectKeyFactory,
  ) {}

  async create(input: CreateMediaObjectInput): Promise<MediaObjectRecord> {
    const temporaryKey = `media/pending/${randomUUID()}`;

    try {
      return await this.db.transaction(async (tx) => {
        const inserted = await tx
          .insert(mediaObjects)
          .values({
            ownerUserId: input.ownerUserId,
            objectKey: temporaryKey,
            contentType: input.contentType,
            sizeBytes: input.sizeBytes,
            status: 'pending',
          })
          .returning(mediaObjectSelection);

        const row = inserted[0];

        if (!row) {
          throw new PersistenceException('PostgreSQL did not return the created media object');
        }

        const objectKey = this.keys.build(input.ownerUserId, row.id, input.contentType);
        const updated = await tx
          .update(mediaObjects)
          .set({ objectKey, updatedAt: new Date() })
          .where(eq(mediaObjects.id, row.id))
          .returning(mediaObjectSelection);

        const finalRow = updated[0];

        if (!finalRow) {
          throw new PersistenceException('Failed to assign the media object key');
        }

        return this.mapper.toRecord(finalRow);
      });
    } catch (error) {
      if (error instanceof PersistenceException) {
        throw error;
      }

      throw new PersistenceException('Failed to create media object', { cause: error });
    }
  }

  async findOwned(id: string, ownerUserId: string): Promise<MediaObjectRecord | null> {
    try {
      const rows = await this.db
        .select(mediaObjectSelection)
        .from(mediaObjects)
        .where(and(eq(mediaObjects.id, id), eq(mediaObjects.ownerUserId, ownerUserId)))
        .limit(1);

      const row = rows[0];

      return row ? this.mapper.toRecord(row) : null;
    } catch (error) {
      throw new PersistenceException('Failed to read media object', { cause: error });
    }
  }

  async findById(mediaId: string): Promise<MediaObjectRecord | null> {
    try {
      const rows = await this.db
        .select(mediaObjectSelection)
        .from(mediaObjects)
        .where(eq(mediaObjects.id, mediaId))
        .limit(1);
      const row = rows[0];
      return row === undefined ? null : this.mapper.toRecord(row);
    } catch (error) {
      throw new PersistenceException('Failed to read media object', { cause: error });
    }
  }

  transitionToReady(
    id: string,
    ownerUserId: string,
    sha256: string | null,
    versionId: string | null,
  ): Promise<MediaObjectRecord | null> {
    return this.transition(id, ownerUserId, {
      status: 'ready',
      sha256,
      versionId,
      finalizedAt: new Date(),
      scanError: null,
    });
  }

  transitionToQuarantined(
    id: string,
    ownerUserId: string,
    signature: string,
    error: string | null,
    versionId: string | null,
  ): Promise<MediaObjectRecord | null> {
    return this.transition(id, ownerUserId, {
      status: 'quarantined',
      scanSignature: signature.slice(0, 512),
      scanError: error === null ? null : error.slice(0, 512),
      versionId,
      finalizedAt: new Date(),
    });
  }

  markFailed(
    id: string,
    ownerUserId: string,
    error: string,
    versionId: string | null,
  ): Promise<MediaObjectRecord | null> {
    return this.transition(id, ownerUserId, {
      status: 'failed',
      scanError: error.slice(0, 512),
      versionId,
    });
  }

  async deleteOwned(id: string, ownerUserId: string): Promise<boolean> {
    try {
      const rows = await this.db
        .delete(mediaObjects)
        .where(and(eq(mediaObjects.id, id), eq(mediaObjects.ownerUserId, ownerUserId)))
        .returning({ id: mediaObjects.id });

      return rows.length > 0;
    } catch (error) {
      throw new PersistenceException('Failed to delete media object', { cause: error });
    }
  }

  private async transition(
    id: string,
    ownerUserId: string,
    values: Partial<{
      status: 'ready' | 'quarantined' | 'failed';
      sha256: string | null;
      versionId: string | null;
      scanSignature: string;
      scanError: string | null;
      finalizedAt: Date;
    }>,
  ): Promise<MediaObjectRecord | null> {
    try {
      const rows = await this.db
        .update(mediaObjects)
        .set({ ...values, updatedAt: new Date() })
        .where(
          and(
            eq(mediaObjects.id, id),
            eq(mediaObjects.ownerUserId, ownerUserId),
            eq(mediaObjects.status, 'pending'),
          ),
        )
        .returning(mediaObjectSelection);

      const row = rows[0];

      return row ? this.mapper.toRecord(row) : null;
    } catch (error) {
      throw new PersistenceException('Failed to transition media object', { cause: error });
    }
  }
}
