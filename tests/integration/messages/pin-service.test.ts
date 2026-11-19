import { Container } from 'inversify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConflictException } from '@/core/errors/http.error.js';
import type { PinService } from '@/modules/messages/logic/pin.service.js';
import type { ChatRepository } from '@/modules/messages/logic/ports/chat.repository.js';
import type { ChatMemberRepository } from '@/modules/messages/logic/ports/chat-member.repository.js';
import type { MessageRepository } from '@/modules/messages/logic/ports/message.repository.js';
import { MessagesContainer } from '@/modules/messages/messages.container.js';
import { MESSAGES_TYPES } from '@/modules/messages/messages.types.js';
import { AuthFixture } from '../../fixtures/auth.fixture.js';
import { TestApp } from '../../helpers/test-app.js';

describe('PinService', () => {
  let app: TestApp;
  let auth: AuthFixture;
  let chats: ChatRepository;
  let members: ChatMemberRepository;
  let messages: MessageRepository;
  let pins: PinService;

  beforeAll(async () => {
    app = await TestApp.create();
    auth = new AuthFixture(app);
    // An intermediate container keeps the extra module's root-level binding
    // off app.container, so HTTP requests through the app still see one binding.
    const container = new MessagesContainer(new Container({ parent: app.container }));
    chats = container.get(MESSAGES_TYPES.ChatRepository);
    members = container.get(MESSAGES_TYPES.ChatMemberRepository);
    messages = container.get(MESSAGES_TYPES.MessageRepository);
    pins = container.get(MESSAGES_TYPES.PinService);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await app.clearDatabase();
    auth.emails.clear();
  });

  async function pair() {
    // Verified so the HTTP assertion in the last test passes RequireVerifiedEmail.
    const alice = await auth.createUser({ emailVerifiedAt: new Date() });
    const bob = await auth.createUser({ emailVerifiedAt: new Date() });
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

  it('rejects a non-member and a message from another chat', async () => {
    const { alice, chat } = await pair();
    const outsider = await auth.createUser();
    const other = await chats.create({
      type: 'direct',
      title: null,
      directKey: [alice.id, outsider.id].sort().join(':'),
      createdBy: alice.id,
    });
    await members.add(other.id, alice.id);
    await members.add(other.id, outsider.id);
    const foreign = await messages.create({ chatId: other.id, senderId: outsider.id, body: 'x' });

    await expect(pins.pin(outsider.id, chat.id, foreign.id, 3_600)).rejects.toThrow(
      'You are not a member of this chat',
    );
    await expect(pins.pin(alice.id, chat.id, foreign.id, 3_600)).rejects.toMatchObject({
      status: 404,
    });
  });

  it('rejects a soft-deleted message and omits it from the list', async () => {
    const { alice, bob, chat } = await pair();
    const message = await messages.create({ chatId: chat.id, senderId: bob.id, body: 'gone' });
    await pins.pin(alice.id, chat.id, message.id, 3_600);
    await messages.markDeleted(chat.id, message.id, new Date());

    await expect(pins.pin(alice.id, chat.id, message.id, 3_600)).rejects.toMatchObject({
      status: 404,
    });
    expect(await pins.list(alice.id, chat.id)).toEqual([]);
  });

  it('translates the repository cap signal into a conflict error', async () => {
    const { alice, bob, chat } = await pair();
    for (let index = 0; index < 10; index += 1) {
      const message = await messages.create({
        chatId: chat.id,
        senderId: bob.id,
        body: `message ${index}`,
      });
      await pins.pin(alice.id, chat.id, message.id, 3_600);
    }
    const extra = await messages.create({ chatId: chat.id, senderId: bob.id, body: 'extra' });

    await expect(pins.pin(alice.id, chat.id, extra.id, 3_600)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(await pins.list(alice.id, chat.id)).toHaveLength(10);
  });

  it('lists pinned messages newest-first with their full records', async () => {
    const { alice, bob, chat } = await pair();
    const first = await messages.create({ chatId: chat.id, senderId: bob.id, body: 'first' });
    const second = await messages.create({ chatId: chat.id, senderId: bob.id, body: 'second' });
    await pins.pin(alice.id, chat.id, first.id, 3_600);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await pins.pin(alice.id, chat.id, second.id, 3_600);

    const list = await pins.list(alice.id, chat.id);
    expect(list.map((item) => item.message.id)).toEqual([second.id, first.id]);
    expect(list[0]?.pinnedAt).toBeInstanceOf(Date);
  });

  it('shows pinnedAt only to the user who pinned the message', async () => {
    const { alice, bob, chat } = await pair();
    const aliceToken = await auth.mintTokens(alice);
    const bobToken = await auth.mintTokens(bob);
    const message = await messages.create({ chatId: chat.id, senderId: bob.id, body: 'visible' });
    await pins.pin(alice.id, chat.id, message.id, 3_600);

    async function pinnedAtFor(headers: Record<string, string>): Promise<string | null> {
      const response = await app.request.get(`/api/chats/${chat.id}/messages`).set(headers);
      const data = response.body.data as Array<{ id: string; pinnedAt: string | null }>;
      expect(response.status).toBe(200);
      return data.find((item) => item.id === message.id)?.pinnedAt ?? null;
    }

    expect(await pinnedAtFor(auth.bearerHeader(aliceToken.accessToken))).not.toBeNull();
    expect(await pinnedAtFor(auth.bearerHeader(bobToken.accessToken))).toBeNull();
  });

  it('returns a server-computed expiry and keeps active re-pins idempotent', async () => {
    const { alice, bob, chat } = await pair();
    const message = await messages.create({ chatId: chat.id, senderId: bob.id, body: 'timed' });

    const before = Date.now();
    const first = await pins.pin(alice.id, chat.id, message.id, 60);
    const after = Date.now();

    expect(first.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 60_000);
    expect(first.expiresAt.getTime()).toBeLessThanOrEqual(after + 60_000);

    const duplicate = await pins.pin(alice.id, chat.id, message.id, 604800);
    expect(duplicate.pinnedAt.toISOString()).toBe(first.pinnedAt.toISOString());
    expect(duplicate.expiresAt.toISOString()).toBe(first.expiresAt.toISOString());
  });

  it('omits elapsed pins from list after the row is aged out', async () => {
    const { alice, bob, chat } = await pair();
    const message = await messages.create({ chatId: chat.id, senderId: bob.id, body: 'aged' });
    await pins.pin(alice.id, chat.id, message.id, 60);
    await app.pool.query(
      `UPDATE message_pins SET expires_at = now() - interval '1 second'
       WHERE chat_id = $1 AND user_id = $2 AND message_id = $3`,
      [chat.id, alice.id, message.id],
    );

    const list = await pins.list(alice.id, chat.id);
    expect(list).toEqual([]);
    expect(list[0]?.expiresAt).toBeUndefined();
  });
});
