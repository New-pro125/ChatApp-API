import { Queue } from 'bullmq';
import { Container } from 'inversify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PinCleanupWorker } from '@/modules/messages/logic/pin-cleanup.worker.js';
import type { ChatRepository } from '@/modules/messages/logic/ports/chat.repository.js';
import type { ChatMemberRepository } from '@/modules/messages/logic/ports/chat-member.repository.js';
import type { MessageRepository } from '@/modules/messages/logic/ports/message.repository.js';
import type { MessagePinRepository } from '@/modules/messages/logic/ports/message-pin.repository.js';
import { MessagesContainer } from '@/modules/messages/messages.container.js';
import { MESSAGES_TYPES } from '@/modules/messages/messages.types.js';
import { AuthFixture } from '../../fixtures/auth.fixture.js';
import { TestApp } from '../../helpers/test-app.js';

describe('PinCleanupWorker', () => {
  let app: TestApp;
  let auth: AuthFixture;
  let chats: ChatRepository;
  let members: ChatMemberRepository;
  let messages: MessageRepository;
  let pins: MessagePinRepository;
  let worker: PinCleanupWorker;

  beforeAll(async () => {
    app = await TestApp.create();
    auth = new AuthFixture(app);
    const container = new MessagesContainer(new Container({ parent: app.container }));
    chats = container.get(MESSAGES_TYPES.ChatRepository);
    members = container.get(MESSAGES_TYPES.ChatMemberRepository);
    messages = container.get(MESSAGES_TYPES.MessageRepository);
    pins = container.get(MESSAGES_TYPES.MessagePinRepository);
    worker = container.get(MESSAGES_TYPES.PinCleanupWorker);
    await worker.start();

    // Check the scheduler before beforeEach flushes Redis.
    const queue = new Queue('pin-cleanup', { connection: app.redis });
    try {
      const schedulers = await queue.getJobSchedulers();
      expect(schedulers).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: 'delete-expired-pins', every: 300_000 }),
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
    await app.close();
  });

  beforeEach(async () => {
    await app.clearDatabase();
    auth.emails.clear();
  });

  it('deletes only elapsed rows in bounded batches', async () => {
    const alice = await auth.createUser();
    const bob = await auth.createUser();
    const chat = await chats.create({
      type: 'direct',
      title: null,
      directKey: [alice.id, bob.id].sort().join(':'),
      createdBy: alice.id,
    });
    await members.add(chat.id, alice.id);
    await members.add(chat.id, bob.id);

    const expiredIds: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const message = await messages.create({
        chatId: chat.id,
        senderId: bob.id,
        body: `expired ${index}`,
      });
      expiredIds.push(message.id);
      await pins.pin(chat.id, alice.id, message.id, new Date(Date.now() + 3_600_000));
    }
    const active = await messages.create({ chatId: chat.id, senderId: bob.id, body: 'active' });
    await pins.pin(chat.id, alice.id, active.id, new Date(Date.now() + 3_600_000));

    for (const id of expiredIds) {
      await app.pool.query(
        `UPDATE message_pins SET expires_at = now() - interval '1 second'
         WHERE chat_id = $1 AND user_id = $2 AND message_id = $3`,
        [chat.id, alice.id, id],
      );
    }

    const result = await worker.process();
    expect(result.deleted).toBe(3);
    expect((await pins.list(chat.id, alice.id)).map((pin) => pin.messageId)).toEqual([active.id]);
  });
});
