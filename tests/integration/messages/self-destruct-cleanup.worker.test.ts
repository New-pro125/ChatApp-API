import { Queue } from 'bullmq';
import { Container } from 'inversify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { MessageRepository } from '@/modules/messages/logic/ports/message.repository.js';
import type { MessagePinRepository } from '@/modules/messages/logic/ports/message-pin.repository.js';
import type { SelfDestructCleanupWorker } from '@/modules/messages/logic/self-destruct-cleanup.worker.js';
import { MessagesContainer } from '@/modules/messages/messages.container.js';
import { MESSAGES_TYPES } from '@/modules/messages/messages.types.js';
import { AuthFixture } from '../../fixtures/auth.fixture.js';
import { MediaFixture, type UploadTicketResponse } from '../../fixtures/media.fixture.js';
import { expectSuccess } from '../../helpers/assertions.js';
import { TestApp } from '../../helpers/test-app.js';
import { MessagingApiFixture } from './messaging-api.fixture.js';

describe('SelfDestructCleanupWorker', () => {
  let app: TestApp;
  let auth: AuthFixture;
  let fixture: MessagingApiFixture;
  let media: MediaFixture;
  let messages: MessageRepository;
  let pins: MessagePinRepository;
  let worker: SelfDestructCleanupWorker;

  beforeAll(async () => {
    app = await TestApp.create();
    auth = new AuthFixture(app);
    fixture = new MessagingApiFixture(app);
    media = new MediaFixture(app);
    const container = new MessagesContainer(new Container({ parent: app.container }));
    messages = container.get(MESSAGES_TYPES.MessageRepository);
    pins = container.get(MESSAGES_TYPES.MessagePinRepository);
    worker = container.get(MESSAGES_TYPES.SelfDestructCleanupWorker);
    await worker.start();

    const queue = new Queue('self-destruct-cleanup', { connection: app.redis });
    try {
      const schedulers = await queue.getJobSchedulers();
      expect(schedulers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'scrub-expired-messages', every: 300_000 }),
        ]),
      );
    } finally {
      await queue.close();
    }
    expect(worker.isRunning()).toBe(true);
  });

  afterAll(async () => {
    await worker.close();
    expect(worker.isRunning()).toBe(false);
    await worker.close();
    await media.cleanup();
    await app.close();
  });

  beforeEach(async () => {
    await app.clearDatabase();
    auth.emails.clear();
    media.scanner.mode = 'clean';
  });

  async function createAgedMessage(senderId: string, chatId: string, body: string) {
    const created = await messages.create({
      chatId,
      senderId,
      body,
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    await app.pool.query(
      `UPDATE messages SET created_at = now() - interval '2 seconds',
       expires_at = now() - interval '1 second'
       WHERE chat_id = $1 AND id = $2`,
      [chatId, created.id],
    );
    return created;
  }

  it('scrubs expired content, removes pins, and leaves active rows alone', async () => {
    const alice = await fixture.verifiedUser('Alice');
    const bob = await fixture.verifiedUser('Bob');
    const chatId = await fixture.openDirectChat(bob.id, alice.headers);
    const expired = await createAgedMessage(bob.id, chatId, 'expired body');
    const active = await messages.create({ chatId, senderId: bob.id, body: 'active body' });
    await pins.pin(chatId, alice.id, expired.id, new Date(Date.now() + 3_600_000));

    const result = await worker.process();
    expect(result.scrubbed).toBe(1);

    const raw = await app.pool.query<{ body: string | null; deleted_at: Date | null }>(
      `SELECT body, deleted_at FROM messages WHERE chat_id = $1 AND id = $2`,
      [chatId, expired.id],
    );
    expect(raw.rows[0]?.body).toBeNull();
    expect(raw.rows[0]?.deleted_at).not.toBeNull();
    expect(await pins.list(chatId, alice.id)).toEqual([]);
    expect((await messages.findById(chatId, active.id))?.body).toBe('active body');
    expect((await worker.process()).scrubbed).toBe(0);
  });

  it('releases shared media only after the last live forward expires', async () => {
    const sender = await fixture.verifiedUser('Sender');
    const recipient = await fixture.verifiedUser('Recipient');
    const third = await fixture.verifiedUser('Third');
    const chatA = await fixture.openDirectChat(recipient.id, sender.headers);
    const chatB = await fixture.openDirectChat(third.id, sender.headers);

    const ticketResponse = await app.request
      .post('/api/media/uploads')
      .set(sender.headers)
      .send({ contentType: 'image/png', sizeBytes: 14 });
    const ticket = expectSuccess<UploadTicketResponse>(ticketResponse, 201);
    media.track(ticket);
    await media.put(ticket, Buffer.from('original-bytes'), 'image/png');
    expectSuccess(
      await app.request.post(`/api/media/${ticket.mediaId}/finalize`).set(sender.headers),
      200,
    );

    const first = expectSuccess<{ id: string }>(
      await app.request
        .post(`/api/chats/${chatA}/messages/media`)
        .set(sender.headers)
        .send({ mediaId: ticket.mediaId, kind: 'image' }),
      201,
    );
    const second = expectSuccess<{ id: string }>(
      await app.request
        .post(`/api/chats/${chatA}/messages/${first.id}/forward`)
        .set(sender.headers)
        .send({ targetChatId: chatB }),
      201,
    );

    await app.pool.query(
      `UPDATE messages SET created_at = now() - interval '2 seconds',
       expires_at = now() - interval '1 second'
       WHERE media_id = $1 AND id = $2`,
      [ticket.mediaId, first.id],
    );
    expect((await worker.process()).scrubbed).toBe(1);
    expect(
      expectSuccess(await app.request.get(`/api/media/${ticket.mediaId}`).set(sender.headers), 200),
    ).toBeDefined();

    await app.pool.query(
      `UPDATE messages SET created_at = now() - interval '2 seconds',
       expires_at = now() - interval '1 second'
       WHERE media_id = $1 AND id = $2`,
      [ticket.mediaId, second.id],
    );
    expect((await worker.process()).scrubbed).toBe(1);
    expect(
      (await app.pool.query(`SELECT id FROM media_objects WHERE id = $1`, [ticket.mediaId])).rows,
    ).toEqual([]);
  });
});
