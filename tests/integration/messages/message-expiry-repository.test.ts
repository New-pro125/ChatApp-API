import { Container } from 'inversify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ChatRepository } from '@/modules/messages/logic/ports/chat.repository.js';
import type { ChatMemberRepository } from '@/modules/messages/logic/ports/chat-member.repository.js';
import type { MessageRepository } from '@/modules/messages/logic/ports/message.repository.js';
import { MessagesContainer } from '@/modules/messages/messages.container.js';
import { MESSAGES_TYPES } from '@/modules/messages/messages.types.js';
import { AuthFixture } from '../../fixtures/auth.fixture.js';
import { TestApp } from '../../helpers/test-app.js';

describe('message expiry repository behavior', () => {
  let app: TestApp;
  let auth: AuthFixture;
  let chats: ChatRepository;
  let members: ChatMemberRepository;
  let messages: MessageRepository;

  beforeAll(async () => {
    app = await TestApp.create();
    auth = new AuthFixture(app);
    const container = new MessagesContainer(new Container({ parent: app.container }));
    chats = container.get(MESSAGES_TYPES.ChatRepository);
    members = container.get(MESSAGES_TYPES.ChatMemberRepository);
    messages = container.get(MESSAGES_TYPES.MessageRepository);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await app.clearDatabase();
    auth.emails.clear();
  });

  async function setup() {
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
    return { alice, bob, chat };
  }

  /** Moves both timestamps back so the `expires_at > created_at` check still holds. */
  function age(chatId: string, messageId: string): Promise<unknown> {
    return app.pool.query(
      `UPDATE messages SET created_at = now() - interval '2 seconds',
       expires_at = now() - interval '1 second'
       WHERE chat_id = $1 AND id = $2`,
      [chatId, messageId],
    );
  }

  it('hides elapsed messages from find/list/count/max while preserving manual tombstones', async () => {
    const { alice, bob, chat } = await setup();
    const expiring = await messages.create({
      chatId: chat.id,
      senderId: bob.id,
      body: 'expiring',
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    const manual = await messages.create({ chatId: chat.id, senderId: bob.id, body: 'manual' });
    await messages.markDeleted(chat.id, manual.id, new Date());
    await age(chat.id, expiring.id);

    expect(await messages.findById(chat.id, expiring.id)).toBeNull();
    expect((await messages.listByChat(chat.id, { limit: 10 })).map((row) => row.id)).toEqual([
      manual.id,
    ]);
    expect((await messages.listByIds(chat.id, [expiring.id])).map((row) => row.id)).toEqual([]);
    expect(await messages.maxIdByChat(chat.id)).toBe(manual.id);
    expect(await messages.countUnread(chat.id, bob.id, null)).toBe(0);
    expect(await messages.countUnread(chat.id, alice.id, null)).toBe(0);

    const manualRow = await messages.findById(chat.id, manual.id);
    expect(manualRow?.deletedAt).not.toBeNull();
  });

  it('lists only elapsed live rows and scrubs content idempotently', async () => {
    const { bob, chat } = await setup();
    const expired = await messages.create({
      chatId: chat.id,
      senderId: bob.id,
      body: 'secret text in a plain row',
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    const active = await messages.create({ chatId: chat.id, senderId: bob.id, body: 'active' });
    await age(chat.id, expired.id);

    const due = await messages.listExpired(new Date(), 10);
    expect(due.map((row) => row.id)).toEqual([expired.id]);

    expect(await messages.scrubExpired(chat.id, expired.id, new Date())).toBe(true);
    expect(await messages.scrubExpired(chat.id, expired.id, new Date())).toBe(false);

    const raw = await app.pool.query<{
      body: string | null;
      deleted_at: Date | null;
      expires_at: Date | null;
      sender_id: string;
    }>(
      `SELECT body, deleted_at, expires_at, sender_id FROM messages
       WHERE chat_id = $1 AND id = $2`,
      [chat.id, expired.id],
    );
    expect(raw.rows[0]).toMatchObject({
      body: null,
      expires_at: expect.any(Date),
      sender_id: bob.id,
    });
    expect(raw.rows[0]?.deleted_at).not.toBeNull();
    expect((await messages.listExpired(new Date(), 10)).map((row) => row.id)).toEqual([]);
    expect((await messages.listByChat(chat.id, { limit: 10 })).map((row) => row.id)).toEqual([
      active.id,
    ]);
  });
});
