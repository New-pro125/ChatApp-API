import { Container } from 'inversify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { MessageMentionRepository } from '@/modules/messages/logic/ports/message-mention.repository.js';
import { MessagesContainer } from '@/modules/messages/messages.container.js';
import { MESSAGES_TYPES } from '@/modules/messages/messages.types.js';
import { expectError, expectSuccess } from '../../helpers/assertions.js';
import { TestApp } from '../../helpers/test-app.js';
import { type ApiUser, MessagingApiFixture } from './messaging-api.fixture.js';

interface MentionItem {
  id: string;
  chatId: string;
  messageId: string;
  readAt: string | null;
  mentionedBy: {
    userId: string;
    username: string | null;
    displayName: string;
    avatarKey: string | null;
  };
}

interface Inbox {
  unreadCount: number;
  mentions: MentionItem[];
}

describe('mention inbox API', () => {
  let app: TestApp;
  let fixture: MessagingApiFixture;
  let mentions: MessageMentionRepository;

  beforeAll(async () => {
    app = await TestApp.create();
    fixture = new MessagingApiFixture(app);
    const container = new MessagesContainer(new Container({ parent: app.container }));
    mentions = container.get<MessageMentionRepository>(MESSAGES_TYPES.MessageMentionRepository);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await app.clearDatabase();
    fixture.auth.emails.clear();
  });

  async function pair() {
    const alice = await fixture.verifiedUser('Alice');
    const bob = await fixture.verifiedUser('Bob');
    const chatId = await fixture.openDirectChat(bob.id, alice.headers);
    await app.pool.query(`UPDATE users SET username = $1 WHERE id = $2`, ['alice_01', alice.id]);
    await app.pool.query(`UPDATE users SET username = $1 WHERE id = $2`, ['bob_01', bob.id]);
    return { alice, bob, chatId };
  }

  async function send(chatId: string, user: ApiUser, body: string): Promise<string> {
    const response = await app.request
      .post(`/api/chats/${chatId}/messages`)
      .set(user.headers)
      .send({ body });
    return expectSuccess<{ id: string }>(response, 201).id;
  }

  function inbox(user: ApiUser): Promise<Inbox> {
    return app.request
      .get('/api/chats/mentions')
      .set(user.headers)
      .then((response) => expectSuccess<Inbox>(response, 200));
  }

  it('lists a caller-scoped inbox with unread count and keyset paging', async () => {
    const { alice, bob, chatId } = await pair();
    const first = await send(chatId, alice, 'one @bob_01');
    const second = await send(chatId, alice, 'two @bob_01');
    await send(chatId, alice, 'three @bob_01');

    const page = await app.request.get('/api/chats/mentions?limit=2').set(bob.headers);
    const body = expectSuccess<Inbox>(page, 200);
    expect(body.unreadCount).toBe(3);
    expect(body.mentions).toHaveLength(2);
    expect(body.mentions[0]?.messageId).not.toBe(first);
    expect(body.mentions[0]?.readAt).toBeNull();
    expect(body.mentions[0]?.mentionedBy).toEqual({
      userId: alice.id,
      username: 'alice_01',
      displayName: 'Alice',
      avatarKey: null,
    });
    expect(body.mentions[0]).not.toHaveProperty('body');
    expect(page.body.meta.pagination.nextCursor).toBeTypeOf('string');

    const cursor = page.body.meta.pagination.nextCursor as string;
    const next = await app.request
      .get(`/api/chats/mentions?limit=2&cursor=${cursor}`)
      .set(bob.headers);
    const rest = expectSuccess<Inbox>(next, 200);
    expect(rest.mentions.map((item) => item.messageId)).toEqual([first]);
    expect(rest.mentions.some((item) => item.messageId === second)).toBe(false);

    const aliceInbox = await inbox(alice);
    expect(aliceInbox.mentions).toEqual([]);
    expect(aliceInbox.unreadCount).toBe(0);
  });

  it('marks one and many mentions read idempotently', async () => {
    const { alice, bob, chatId } = await pair();
    await send(chatId, alice, 'one @bob_01');
    await send(chatId, alice, 'two @bob_01');

    const before = await inbox(bob);
    const ids = before.mentions.map((item) => item.id);
    expect(ids).toHaveLength(2);

    const one = expectSuccess<{ id: string; readAt: string }>(
      await app.request.post(`/api/chats/mentions/${ids[0]}/read`).set(bob.headers),
      200,
    );
    expect(one.id).toBe(ids[0]);
    expect(Number.isNaN(Date.parse(one.readAt))).toBe(false);

    const again = expectSuccess<{ id: string; readAt: string }>(
      await app.request.post(`/api/chats/mentions/${ids[0]}/read`).set(bob.headers),
      200,
    );
    expect(again.readAt).toBe(one.readAt);

    const marked = expectSuccess<{ marked: number }>(
      await app.request
        .post('/api/chats/mentions/read')
        .set(bob.headers)
        .send({ mentionIds: [...ids, ...ids] }),
      200,
    );
    expect(marked.marked).toBe(1);
    expect((await inbox(bob)).unreadCount).toBe(0);
  });

  it('preserves read state for a retained mention across edits', async () => {
    const { alice, bob, chatId } = await pair();
    const messageId = await send(chatId, alice, 'one @bob_01 @alice_01');
    const before = await inbox(bob);
    expect(before.mentions).toHaveLength(1);
    const mentionId = before.mentions[0]?.id as string;

    const read = expectSuccess<{ id: string; readAt: string }>(
      await app.request.post(`/api/chats/mentions/${mentionId}/read`).set(bob.headers),
      200,
    );
    expect((await inbox(bob)).unreadCount).toBe(0);

    await app.request
      .patch(`/api/chats/${chatId}/messages/${messageId}`)
      .set(alice.headers)
      .send({ body: 'now @bob_01 only' });
    const after = await inbox(bob);
    expect(after.mentions).toHaveLength(1);
    expect(after.mentions[0]?.id).toBe(mentionId);
    expect(after.mentions[0]?.readAt).toBe(read.readAt);
    expect(after.unreadCount).toBe(0);

    await app.request
      .patch(`/api/chats/${chatId}/messages/${messageId}`)
      .set(alice.headers)
      .send({ body: 'removed @alice_01' });
    expect((await inbox(bob)).mentions).toEqual([]);

    await app.request
      .patch(`/api/chats/${chatId}/messages/${messageId}`)
      .set(alice.headers)
      .send({ body: 'again @BOB_01' });
    expect((await inbox(bob)).unreadCount).toBe(1);
  });

  it('returns 404 for another user mention and 400 for invalid input', async () => {
    const { alice, bob, chatId } = await pair();
    const messageId = await send(chatId, alice, 'one @bob_01');
    const id = (await inbox(bob)).mentions[0]?.id as string;

    expectError(
      await app.request.post(`/api/chats/mentions/${id}/read`).set(alice.headers),
      404,
      'NOT_FOUND',
    );
    expectError(
      await app.request.post('/api/chats/mentions/not-a-uuid/read').set(bob.headers),
      400,
      'VALIDATION_ERROR',
    );
    expectError(
      await app.request.post('/api/chats/mentions/read').set(bob.headers).send({ mentionIds: [] }),
      400,
      'VALIDATION_ERROR',
    );
    expectError(await app.request.get('/api/chats/mentions'), 401, 'UNAUTHORIZED');

    await app.request.delete(`/api/chats/${chatId}/messages/${messageId}`).set(alice.headers);
    expectError(
      await app.request.post(`/api/chats/mentions/${id}/read`).set(bob.headers),
      404,
      'NOT_FOUND',
    );
  });

  it('gates every mention route behind verified email', async () => {
    const { alice } = await pair();
    const unverified = await fixture.unverifiedUser('Unverified');
    await app.pool.query(`UPDATE users SET username = $1 WHERE id = $2`, [
      'unverified_01',
      unverified.id,
    ]);
    const chatId = await fixture.openDirectChat(unverified.id, alice.headers);
    await send(chatId, alice, 'ping @unverified_01');

    const records = await mentions.list(unverified.id, { limit: 10 });
    const record = records[0];
    if (!record) {
      throw new Error('missing mention row');
    }

    expectError(
      await app.request.get('/api/chats/mentions').set(unverified.headers),
      403,
      'EMAIL_NOT_VERIFIED',
    );
    expectError(
      await app.request.post(`/api/chats/mentions/${record.id}/read`).set(unverified.headers),
      403,
      'EMAIL_NOT_VERIFIED',
    );
    expectError(
      await app.request
        .post('/api/chats/mentions/read')
        .set(unverified.headers)
        .send({ mentionIds: [record.id] }),
      403,
      'EMAIL_NOT_VERIFIED',
    );
  });

  it('keeps unknown and non-member names as plain text', async () => {
    const { alice, bob, chatId } = await pair();
    const outsider = await fixture.verifiedUser('Outsider');
    await app.pool.query(`UPDATE users SET username = $1 WHERE id = $2`, [
      'outside_01',
      outsider.id,
    ]);

    const message = expectSuccess<{ body: string; mentions: unknown[] }>(
      await app.request
        .post(`/api/chats/${chatId}/messages`)
        .set(alice.headers)
        .send({ body: 'hi @nobody_01 and @outside_01 and alice@example.com' }),
      201,
    );

    expect(message.body).toBe('hi @nobody_01 and @outside_01 and alice@example.com');
    expect(message.mentions).toEqual([]);
    expect((await inbox(bob)).mentions).toEqual([]);
    expect((await inbox(outsider)).mentions).toEqual([]);
  });
});
