import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { UniqueConstraintException } from '@/core/errors/repository.error.js';
import type { ChatRepository } from '@/modules/messages/logic/ports/chat.repository.js';
import type { ChatMemberRepository } from '@/modules/messages/logic/ports/chat-member.repository.js';
import type { MessagePinRepository } from '@/modules/messages/logic/ports/message-pin.repository.js';
import type { MessageRepository } from '@/modules/messages/logic/ports/message.repository.js';
import { MessagesContainer } from '@/modules/messages/messages.container.js';
import { MESSAGES_TYPES } from '@/modules/messages/messages.types.js';
import { AuthFixture } from '../../fixtures/auth.fixture.js';
import { TestApp } from '../../helpers/test-app.js';

/** Pages a chat's whole history, newest-first, following the id cursor. */
async function collectAllMessageIds(
  repository: MessageRepository,
  chatId: string,
  pageSize: number,
): Promise<string[]> {
  const collected: string[] = [];
  let cursor: string | undefined;

  for (;;) {
    const page = await repository.listByChat(chatId, {
      limit: pageSize,
      ...(cursor === undefined ? {} : { beforeId: cursor }),
    });
    collected.push(...page.map((message) => message.id));

    if (page.length < pageSize) {
      return collected;
    }

    const last = page[page.length - 1];

    if (last === undefined) {
      return collected;
    }

    cursor = last.id;
  }
}

describe('Messaging repositories', () => {
  let app: TestApp;
  let auth: AuthFixture;
  let chats: ChatRepository;
  let members: ChatMemberRepository;
  let messages: MessageRepository;
  let pins: MessagePinRepository;

  beforeAll(async () => {
    app = await TestApp.create();
    auth = new AuthFixture(app);

    const container = new MessagesContainer(app.container);
    chats = container.get(MESSAGES_TYPES.ChatRepository);
    members = container.get(MESSAGES_TYPES.ChatMemberRepository);
    messages = container.get(MESSAGES_TYPES.MessageRepository);
    pins = container.get(MESSAGES_TYPES.MessagePinRepository);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await app.clearDatabase();
    auth.emails.clear();
  });

  async function createGroupChat(ownerId: string): Promise<string> {
    const chat = await chats.create({
      type: 'group',
      title: 'Team',
      directKey: null,
      createdBy: ownerId,
    });
    await members.add(chat.id, ownerId, 'owner');

    return chat.id;
  }

  it('persists a chat and reads it back by id', async () => {
    const owner = await auth.createUser();

    const chat = await chats.create({
      type: 'group',
      title: 'Team',
      directKey: null,
      createdBy: owner.id,
    });

    expect(chat.id).toBeTruthy();
    expect(chat.type).toBe('group');
    expect(chat.title).toBe('Team');
    expect(chat.directKey).toBeNull();

    const found = await chats.findById(chat.id);
    expect(found?.id).toBe(chat.id);
    expect(found?.createdBy).toBe(owner.id);
    expect(await chats.findById('00000000-0000-7000-8000-000000000000')).toBeNull();
  });

  it('enforces one direct chat per user pair', async () => {
    const first = await auth.createUser();
    const second = await auth.createUser();
    const directKey = [first.id, second.id].sort().join(':');

    const chat = await chats.create({
      type: 'direct',
      title: null,
      directKey,
      createdBy: first.id,
    });

    await expect(
      chats.create({ type: 'direct', title: null, directKey, createdBy: first.id }),
    ).rejects.toBeInstanceOf(UniqueConstraintException);

    const found = await chats.findDirectByKey(directKey);
    expect(found?.id).toBe(chat.id);
    expect(await chats.findDirectByKey('nobody:nobody')).toBeNull();
  });

  it('lists only the chats a user belongs to', async () => {
    const first = await auth.createUser();
    const second = await auth.createUser();
    const outsider = await auth.createUser();

    const firstChat = await createGroupChat(first.id);
    const secondChat = await chats.create({
      type: 'group',
      title: 'Second',
      directKey: null,
      createdBy: second.id,
    });
    await members.add(secondChat.id, second.id, 'owner');
    await members.add(secondChat.id, first.id);
    const foreignChat = await createGroupChat(outsider.id);

    const list = await chats.listByUser(first.id);

    expect(list.map((chat) => chat.id).sort()).toEqual([firstChat, secondChat.id].sort());
    expect(list.map((chat) => chat.id)).not.toContain(foreignChat);
  });

  it('adds, finds, lists, and removes members', async () => {
    const owner = await auth.createUser();
    const guest = await auth.createUser();
    const chat = await chats.create({
      type: 'group',
      title: 'Team',
      directKey: null,
      createdBy: owner.id,
    });

    const ownerMembership = await members.add(chat.id, owner.id, 'owner');
    expect(ownerMembership.role).toBe('owner');

    await members.add(chat.id, guest.id);
    const guestMembership = await members.find(chat.id, guest.id);
    expect(guestMembership?.role).toBe('member');
    expect(guestMembership?.leftAt).toBeNull();

    const list = await members.listByChat(chat.id);
    expect(list).toHaveLength(2);

    expect(await members.remove(chat.id, guest.id)).toBe(true);
    expect(await members.find(chat.id, guest.id)).toBeNull();
    expect(await members.remove(chat.id, guest.id)).toBe(false);
  });

  it('persists a message and reads it back within its chat', async () => {
    const owner = await auth.createUser();
    const chatId = await createGroupChat(owner.id);

    const message = await messages.create({ chatId, senderId: owner.id, body: 'hello' });

    expect(message.id).toBeTruthy();
    expect(message.type).toBe('text');
    expect(message.body).toBe('hello');
    expect(message.editedAt).toBeNull();
    expect(message.deletedAt).toBeNull();

    const found = await messages.findById(chatId, message.id);
    expect(found?.id).toBe(message.id);
    expect(await messages.findById(chatId, '00000000-0000-7000-8000-000000000000')).toBeNull();
  });

  it('lists messages newest-first with keyset pagination', async () => {
    const owner = await auth.createUser();
    const chatId = await createGroupChat(owner.id);
    const ids: string[] = [];

    for (let index = 0; index < 5; index += 1) {
      const message = await messages.create({
        chatId,
        senderId: owner.id,
        body: `message ${index}`,
      });
      ids.push(message.id);
      await new Promise((resolve) => setTimeout(resolve, 3));
    }

    const firstPage = await messages.listByChat(chatId, { limit: 2 });
    expect(firstPage.map((message) => message.id)).toEqual([ids[4], ids[3]]);

    const cursor = firstPage[1];
    if (!cursor) {
      throw new Error('Expected a second message on the first page');
    }
    const secondPage = await messages.listByChat(chatId, {
      limit: 2,
      beforeId: cursor.id,
    });
    expect(secondPage.map((message) => message.id)).toEqual([ids[2], ids[1]]);
  });

  it('cannot read or mutate a message through the wrong chat', async () => {
    const owner = await auth.createUser();
    const firstChat = await createGroupChat(owner.id);
    const secondChat = await createGroupChat(owner.id);
    const message = await messages.create({
      chatId: firstChat,
      senderId: owner.id,
      body: 'private',
    });

    expect(await messages.findById(secondChat, message.id)).toBeNull();
    expect(await messages.editBody(secondChat, message.id, 'hijacked', new Date())).toBeNull();
    expect(await messages.markDeleted(secondChat, message.id, new Date())).toBe(false);

    const untouched = await messages.findById(firstChat, message.id);
    expect(untouched?.body).toBe('private');
    expect(untouched?.deletedAt).toBeNull();
  });

  it('returns every message when several share a millisecond', async () => {
    const owner = await auth.createUser();
    const chatId = await createGroupChat(owner.id);
    const inserted: string[] = [];

    // Six messages inside the same millisecond, at distinct microseconds. A
    // millisecond-precision cursor truncates those microseconds and skips rows.
    for (let index = 0; index < 6; index += 1) {
      const micros = 100000 + index * 130;
      const result = await app.pool.query<{ id: string }>(
        `INSERT INTO messages (chat_id, sender_id, body, created_at)
         VALUES ($1, $2, $3, $4::timestamptz) RETURNING id`,
        [chatId, owner.id, `m${index}`, `2026-01-01T00:00:00.${micros}Z`],
      );
      const row = result.rows[0];

      if (!row) {
        throw new Error('Insert did not return a message id');
      }

      inserted.push(row.id);
    }

    const collected = await collectAllMessageIds(messages, chatId, 2);

    expect(new Set(collected).size).toBe(inserted.length);
    expect([...collected].sort()).toEqual([...inserted].sort());
  });

  it('updates a message body and stamps editedAt', async () => {
    const owner = await auth.createUser();
    const chatId = await createGroupChat(owner.id);
    const message = await messages.create({ chatId, senderId: owner.id, body: 'before' });
    const editedAt = new Date();

    const updated = await messages.editBody(chatId, message.id, 'after', editedAt);

    expect(updated?.body).toBe('after');
    expect(updated?.editedAt).toEqual(editedAt);
    expect(
      await messages.editBody(chatId, '00000000-0000-7000-8000-000000000000', 'x', editedAt),
    ).toBeNull();
  });

  it('soft-deletes a message once', async () => {
    const owner = await auth.createUser();
    const chatId = await createGroupChat(owner.id);
    const message = await messages.create({ chatId, senderId: owner.id, body: 'bye' });
    const deletedAt = new Date();

    expect(await messages.markDeleted(chatId, message.id, deletedAt)).toBe(true);

    const found = await messages.findById(chatId, message.id);
    expect(found?.deletedAt).toEqual(deletedAt);
    expect(await messages.markDeleted(chatId, message.id, deletedAt)).toBe(false);
  });

  it('cascades messages and members when a chat is deleted', async () => {
    const owner = await auth.createUser();
    const chatId = await createGroupChat(owner.id);
    const message = await messages.create({ chatId, senderId: owner.id, body: 'gone soon' });

    expect(await chats.delete(chatId)).toBe(true);
    expect(await chats.findById(chatId)).toBeNull();
    expect(await messages.findById(chatId, message.id)).toBeNull();
    expect(await members.listByChat(chatId)).toEqual([]);
    expect(await chats.delete(chatId)).toBe(false);
  });

  it('returns null read watermarks for a fresh membership', async () => {
    const owner = await auth.createUser();
    const chatId = await createGroupChat(owner.id);

    const membership = await members.find(chatId, owner.id);

    expect(membership?.lastReadMessageId).toBeNull();
    expect(membership?.lastReadAt).toBeNull();
  });

  it('marks read monotonically and counts only newer live inbound messages', async () => {
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

    const first = await messages.create({ chatId: chat.id, senderId: bob.id, body: 'one' });
    const second = await messages.create({ chatId: chat.id, senderId: bob.id, body: 'two' });

    // uuidv7 ordering is the pagination and watermark ordering invariant.
    expect(second.id > first.id).toBe(true);

    const afterFirst = await members.markRead(chat.id, alice.id, first.id);
    expect(afterFirst.lastReadMessageId).toBe(first.id);
    expect(afterFirst.lastReadAt).toBeInstanceOf(Date);

    const afterStale = await members.markRead(chat.id, alice.id, first.id);
    expect(afterStale.lastReadMessageId).toBe(first.id);
    expect(afterStale.lastReadAt?.getTime()).toBe(afterFirst.lastReadAt?.getTime());

    await members.markRead(chat.id, alice.id, second.id);
    expect(await messages.countUnread(chat.id, alice.id, first.id)).toBe(1);
    expect(await messages.countUnread(chat.id, alice.id, second.id)).toBe(0);
    expect(await messages.maxIdByChat(chat.id)).toBe(second.id);
  });

  it('ignores own and soft-deleted messages when counting unread', async () => {
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

    await messages.create({ chatId: chat.id, senderId: alice.id, body: 'mine' });
    const inbound = await messages.create({ chatId: chat.id, senderId: bob.id, body: 'theirs' });
    expect(await messages.countUnread(chat.id, alice.id, null)).toBe(1);

    await messages.markDeleted(chat.id, inbound.id, new Date());
    // A deleted message may still be a legitimate watermark target.
    const marked = await members.markRead(chat.id, alice.id, inbound.id);
    expect(marked.lastReadMessageId).toBe(inbound.id);
    expect(await messages.countUnread(chat.id, alice.id, null)).toBe(0);
    expect(await messages.countUnread(chat.id, alice.id, inbound.id)).toBe(0);
  });

  it('counts unread for several chats in one query', async () => {
    const alice = await auth.createUser();
    const bob = await auth.createUser();
    const charlie = await auth.createUser();
    const firstChat = await createGroupChat(alice.id);
    const secondChat = await createGroupChat(alice.id);
    const emptyChatId = await createGroupChat(alice.id);
    await members.add(firstChat, bob.id);
    await members.add(secondChat, charlie.id);
    await messages.create({ chatId: firstChat, senderId: bob.id, body: 'first' });
    await messages.create({ chatId: secondChat, senderId: charlie.id, body: 'second' });

    const selectSpy = vi.spyOn(app.db, 'select');
    const counts = await messages.countUnreadByChats(alice.id, [
      firstChat,
      secondChat,
      emptyChatId,
    ]);
    const queryCount = selectSpy.mock.calls.length;
    selectSpy.mockRestore();

    expect(queryCount).toBe(1);
    expect(counts.get(firstChat)).toBe(1);
    expect(counts.get(secondChat)).toBe(1);
    expect(counts.has(emptyChatId)).toBe(false);
  });

  it('never rewinds the watermark when stale marks race', async () => {
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
    const first = await messages.create({ chatId: chat.id, senderId: bob.id, body: 'one' });
    const second = await messages.create({ chatId: chat.id, senderId: bob.id, body: 'two' });

    await Promise.all([
      members.markRead(chat.id, alice.id, second.id),
      members.markRead(chat.id, alice.id, first.id),
      members.markRead(chat.id, alice.id, second.id),
    ]);

    const current = await members.find(chat.id, alice.id);
    expect(current?.lastReadMessageId).toBe(second.id);
  });

  it('pins, lists, and unpins a message for one user only', async () => {
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
    const message = await messages.create({
      chatId: chat.id,
      senderId: bob.id,
      body: 'important',
    });

    const first = await pins.pin(chat.id, alice.id, message.id);
    expect(first?.messageId).toBe(message.id);
    expect(first?.pinnedAt).toBeInstanceOf(Date);
    expect((await pins.list(chat.id, alice.id)).map((pin) => pin.messageId)).toEqual([message.id]);
    expect(await pins.list(chat.id, bob.id)).toEqual([]);

    const map = await pins.listPinnedFor(chat.id, alice.id, [message.id]);
    expect(map.get(message.id)?.toISOString()).toBe(first?.pinnedAt.toISOString());

    // A duplicate keeps its original timestamp.
    const duplicate = await pins.pin(chat.id, alice.id, message.id);
    expect(duplicate?.pinnedAt.toISOString()).toBe(first?.pinnedAt.toISOString());

    expect(await pins.unpin(chat.id, alice.id, message.id)).toBe(true);
    expect(await pins.unpin(chat.id, alice.id, message.id)).toBe(false);
    expect(await pins.list(chat.id, alice.id)).toEqual([]);
  });

  it('enforces the ten-pin cap under concurrent writes', async () => {
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

    const ids: string[] = [];
    for (let index = 0; index < 11; index += 1) {
      const message = await messages.create({
        chatId: chat.id,
        senderId: bob.id,
        body: `message ${index}`,
      });
      ids.push(message.id);
    }

    for (const id of ids.slice(0, 9)) {
      expect(await pins.pin(chat.id, alice.id, id)).not.toBeNull();
    }

    const results = await Promise.all([
      pins.pin(chat.id, alice.id, ids[9] as string),
      pins.pin(chat.id, alice.id, ids[10] as string),
    ]);

    expect(results.filter((result) => result !== null)).toHaveLength(1);
    expect(await pins.list(chat.id, alice.id)).toHaveLength(10);
  });

  it('removes every user pin of a message and lists only live rows by id', async () => {
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
    const pinned = await messages.create({ chatId: chat.id, senderId: bob.id, body: 'pin me' });
    const removed = await messages.create({ chatId: chat.id, senderId: bob.id, body: 'delete me' });

    await pins.pin(chat.id, alice.id, pinned.id);
    await pins.pin(chat.id, bob.id, pinned.id);
    await messages.markDeleted(chat.id, removed.id, new Date());

    const loaded = await messages.listByIds(chat.id, [pinned.id, removed.id]);
    expect(loaded.map((message) => message.id)).toEqual([pinned.id]);

    await pins.removeForMessage(chat.id, pinned.id);
    expect(await pins.list(chat.id, alice.id)).toEqual([]);
    expect(await pins.list(chat.id, bob.id)).toEqual([]);
  });
});
