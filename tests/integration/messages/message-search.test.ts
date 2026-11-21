import { randomUUID } from 'node:crypto';
import { Container } from 'inversify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ChatRepository } from '@/modules/messages/logic/ports/chat.repository.js';
import type { ChatMemberRepository } from '@/modules/messages/logic/ports/chat-member.repository.js';
import type { MessageRepository } from '@/modules/messages/logic/ports/message.repository.js';
import { MessagesContainer } from '@/modules/messages/messages.container.js';
import { MESSAGES_TYPES } from '@/modules/messages/messages.types.js';
import { AuthFixture } from '../../fixtures/auth.fixture.js';
import { TestApp } from '../../helpers/test-app.js';

describe('message search repository', () => {
  let app: TestApp;
  let auth: AuthFixture;
  let chats: ChatRepository;
  let members: ChatMemberRepository;
  let messages: MessageRepository;

  beforeAll(async () => {
    app = await TestApp.create();
    auth = new AuthFixture(app);
    const container = new MessagesContainer(new Container({ parent: app.container }));
    chats = container.get<ChatRepository>(MESSAGES_TYPES.ChatRepository);
    members = container.get<ChatMemberRepository>(MESSAGES_TYPES.ChatMemberRepository);
    messages = container.get<MessageRepository>(MESSAGES_TYPES.MessageRepository);
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

  async function insertMediaMessage(
    chatId: string,
    senderId: string,
    caption: string,
  ): Promise<string> {
    const media = await app.pool.query<{ id: string }>(
      `INSERT INTO media_objects (owner_user_id, object_key, content_type, size_bytes, status)
       VALUES ($1, $2, 'image/png', 11, 'ready') RETURNING id`,
      [senderId, `media/${senderId}/${randomUUID()}.png`],
    );
    const mediaId = media.rows[0]?.id as string;
    const inserted = await app.pool.query<{ id: string }>(
      `INSERT INTO messages (chat_id, sender_id, type, media_id, media_kind, caption)
       VALUES ($1, $2, 'media', $3, 'image', $4) RETURNING id`,
      [chatId, senderId, mediaId, caption],
    );

    return inserted.rows[0]?.id as string;
  }

  async function insertSecretMessage(chatId: string, senderId: string): Promise<string> {
    const inserted = await app.pool.query<{ id: string }>(
      `INSERT INTO messages (
         chat_id, sender_id, type, ciphertext, nonce, ephemeral_public_key,
         sender_device_id, recipient_device_id
       ) VALUES ($1, $2, 'secret', 'opaque', 'nonce', 'ephemeral', $3, $4) RETURNING id`,
      [chatId, senderId, randomUUID(), randomUUID()],
    );

    return inserted.rows[0]?.id as string;
  }

  it('matches bodies and captions case-insensitively with English stemming', async () => {
    const { alice, chat } = await setup();
    await messages.create({ chatId: chat.id, senderId: alice.id, body: 'The quick brown fox' });
    const captionId = await insertMediaMessage(chat.id, alice.id, 'Running through the park');

    const byBody = await messages.search(chat.id, { q: 'QUICK', limit: 10 });
    expect(byBody.map((message) => message.body)).toEqual(['The quick brown fox']);

    const byCaption = await messages.search(chat.id, { q: 'runs', limit: 10 });
    expect(byCaption.map((message) => message.id)).toEqual([captionId]);
  });

  it('returns newest-first pages with no duplicates or skips', async () => {
    const { alice, chat } = await setup();
    const first = await messages.create({
      chatId: chat.id,
      senderId: alice.id,
      body: 'running one',
    });
    const second = await messages.create({
      chatId: chat.id,
      senderId: alice.id,
      body: 'running two',
    });
    const third = await messages.create({
      chatId: chat.id,
      senderId: alice.id,
      body: 'running three',
    });

    const pageOne = await messages.search(chat.id, { q: 'running', limit: 2 });
    expect(pageOne.map((message) => message.id)).toEqual([third.id, second.id]);

    const pageTwo = await messages.search(chat.id, {
      q: 'running',
      limit: 2,
      beforeId: pageOne[1]?.id,
    });
    expect(pageTwo.map((message) => message.id)).toEqual([first.id]);
  });

  it('excludes other chats, tombstones, expired rows, and secret ciphertext', async () => {
    const { alice, chat } = await setup();
    const live = await messages.create({
      chatId: chat.id,
      senderId: alice.id,
      body: 'running live',
    });
    const deleted = await messages.create({
      chatId: chat.id,
      senderId: alice.id,
      body: 'running deleted',
    });
    await messages.markDeleted(chat.id, deleted.id, new Date());

    await app.pool.query(
      `INSERT INTO messages (chat_id, sender_id, body, created_at, expires_at)
       VALUES ($1, $2, 'running expired', now() - interval '2 seconds', now() - interval '1 second')`,
      [chat.id, alice.id],
    );
    const secretId = await insertSecretMessage(chat.id, alice.id);

    const other = await chats.create({
      type: 'group',
      title: 'Other chat',
      directKey: null,
      createdBy: alice.id,
    });
    await members.add(other.id, alice.id);
    const otherMessage = await messages.create({
      chatId: other.id,
      senderId: alice.id,
      body: 'running elsewhere',
    });

    const ids = (await messages.search(chat.id, { q: 'running', limit: 50 })).map(
      (message) => message.id,
    );
    expect(ids).toEqual([live.id]);
    expect(ids).not.toContain(deleted.id);
    expect(ids).not.toContain(secretId);
    expect(ids).not.toContain(otherMessage.id);
  });
});
