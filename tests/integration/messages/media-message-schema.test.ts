import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CORE_TYPES } from '@/core/container/core.types.js';
import type { AppDatabase } from '@/core/database/database.provider.js';
import { PostgresMessageRepository } from '@/modules/messages/data/postgres-message.repository.js';
import { AuthFixture } from '../../fixtures/auth.fixture.js';
import { TestApp } from '../../helpers/test-app.js';

describe('media message schema and references', () => {
  let app: TestApp;
  let auth: AuthFixture;
  let repository: PostgresMessageRepository;
  let chatId: string;
  let userId: string;

  beforeAll(async () => {
    app = await TestApp.create();
    auth = new AuthFixture(app);
    repository = new PostgresMessageRepository(app.container.get<AppDatabase>(CORE_TYPES.Db));
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await app.clearDatabase();
    const user = await auth.createUser({ emailVerifiedAt: new Date() });
    userId = user.id;
    chatId = randomUUID();
    await app.pool.query(
      `INSERT INTO chats (id, type, direct_key, created_by, created_at, updated_at)
       VALUES ($1, 'direct', $3, $2, now(), now())`,
      [chatId, userId, `direct:${chatId}`],
    );
    await app.pool.query(
      `INSERT INTO chat_members (chat_id, user_id, role) VALUES ($1, $2, 'member')`,
      [chatId, userId],
    );
  });

  it('stores media fields and tracks live references', async () => {
    const mediaId = randomUUID();
    await app.pool.query(
      `INSERT INTO media_objects
        (id, owner_user_id, object_key, content_type, size_bytes, status, created_at, updated_at)
       VALUES ($1, $2, $3, 'image/png', 12, 'ready', now(), now())`,
      [mediaId, userId, `media/${userId}/${mediaId}.png`],
    );

    const message = await repository.create({
      chatId,
      senderId: userId,
      body: null,
      type: 'media',
      media: { mediaId, kind: 'image', caption: null, durationMs: null, width: null, height: null },
    });

    expect(message.type).toBe('media');
    expect(message.media?.mediaId).toBe(mediaId);
    expect(await repository.hasLiveMediaReferences(mediaId)).toBe(true);

    await repository.markDeleted(chatId, message.id, new Date());

    expect(await repository.hasLiveMediaReferences(mediaId)).toBe(false);
  });

  it('rejects media fields on secret rows', async () => {
    const mediaId = randomUUID();

    await expect(
      app.pool.query(
        `INSERT INTO messages
          (chat_id, id, sender_id, type, body, media_id, media_kind, ciphertext, nonce,
           ephemeral_public_key, sender_device_id, recipient_device_id, created_at)
         VALUES ($1, $2, $3, 'secret', NULL, $4, 'image', 'c', 'n', 'e', $5, $5, now())`,
        [chatId, randomUUID(), userId, mediaId, randomUUID()],
      ),
    ).rejects.toThrow(/messages_non_media_no_media_check|violates check constraint/);
  });
});
