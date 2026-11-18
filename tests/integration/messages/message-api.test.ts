import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TestApp } from '../../helpers/test-app.js';
import { type ApiUser, MessagingApiFixture } from './messaging-api.fixture.js';

describe('Message API', () => {
  let app: TestApp;
  let fixture: MessagingApiFixture;

  beforeAll(async () => {
    app = await TestApp.create();
    fixture = new MessagingApiFixture(app);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await app.clearDatabase();
    fixture.auth.emails.clear();
  });

  async function createPair(): Promise<{ alice: ApiUser; bob: ApiUser; chatId: string }> {
    const alice = await fixture.verifiedUser('Alice');
    const bob = await fixture.verifiedUser('Bob');
    const chatId = await fixture.openDirectChat(bob.id, alice.headers);

    return { alice, bob, chatId };
  }

  function send(
    headers: Record<string, string>,
    chatId: string,
    body: string,
    extra: Record<string, unknown> = {},
  ) {
    return app.request
      .post(`/api/chats/${chatId}/messages`)
      .set(headers)
      .send({ body, ...extra });
  }

  it('sends a text message', async () => {
    const { alice, chatId } = await createPair();

    const response = await send(alice.headers, chatId, 'hello');

    expect(response.status).toBe(201);
    expect(response.body.data.chatId).toBe(chatId);
    expect(response.body.data.senderId).toBe(alice.id);
    expect(response.body.data.type).toBe('text');
    expect(response.body.data.body).toBe('hello');
    expect(response.body.data.deletedAt).toBeNull();
  });

  it('rejects an empty or oversized body', async () => {
    const { alice, chatId } = await createPair();

    expect((await send(alice.headers, chatId, '')).status).toBe(400);
    expect((await send(alice.headers, chatId, 'x'.repeat(4097))).status).toBe(400);
  });

  it('rejects a sender who is not a chat member', async () => {
    const { chatId } = await createPair();
    const charlie = await fixture.verifiedUser('Charlie');

    const response = await send(charlie.headers, chatId, 'intruder');

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('NOT_CHAT_MEMBER');
    expect(
      (await app.request.get(`/api/chats/${chatId}/messages`).set(charlie.headers)).status,
    ).toBe(403);
  });

  it('rejects an unverified sender', async () => {
    const { chatId } = await createPair();
    const unverified = await fixture.unverifiedUser('Unverified');

    const response = await app.request
      .post(`/api/chats/${chatId}/messages`)
      .set(unverified.headers)
      .send({ body: 'nope' });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('EMAIL_NOT_VERIFIED');
  });

  it('rejects sending when either side has blocked the other', async () => {
    const { alice, bob, chatId } = await createPair();
    await fixture.block(bob.id, alice.id);

    const response = await send(alice.headers, chatId, 'blocked');

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('USER_BLOCKED');
  });

  it('replies to a message in the same chat', async () => {
    const { alice, chatId } = await createPair();
    const original = await send(alice.headers, chatId, 'original');
    const originalId = original.body.data.id as string;

    const reply = await send(alice.headers, chatId, 'reply', {
      replyToMessageId: originalId,
    });

    expect(reply.status).toBe(201);
    expect(reply.body.data.replyToMessageId).toBe(originalId);
  });

  it('rejects a reply to a message in another chat', async () => {
    const { alice, bob, chatId } = await createPair();
    const charlie = await fixture.verifiedUser('Charlie');
    const otherChat = await fixture.openDirectChat(charlie.id, alice.headers);
    const foreign = await send(bob.headers, chatId, 'foreign');
    const foreignId = foreign.body.data.id as string;

    const response = await send(alice.headers, otherChat, 'reply', {
      replyToMessageId: foreignId,
    });

    expect(response.status).toBe(400);
  });

  it('lists history newest-first with keyset pagination', async () => {
    const { alice, chatId } = await createPair();
    const ids: string[] = [];

    for (let index = 0; index < 5; index += 1) {
      const response = await send(alice.headers, chatId, `message ${index}`);
      ids.push(response.body.data.id as string);
    }

    const first = await app.request.get(`/api/chats/${chatId}/messages?limit=2`).set(alice.headers);
    expect(first.status).toBe(200);
    expect(first.body.data.map((message: { id: string }) => message.id)).toEqual([ids[4], ids[3]]);

    const cursor = first.body.meta.pagination.nextCursor as string;
    expect(cursor).toBe(ids[3]);

    const second = await app.request
      .get(`/api/chats/${chatId}/messages?limit=2&cursor=${cursor}`)
      .set(alice.headers);
    expect(second.body.data.map((message: { id: string }) => message.id)).toEqual([ids[2], ids[1]]);
  });

  it('lets the sender edit a message but not anyone else', async () => {
    const { alice, bob, chatId } = await createPair();
    const created = await send(alice.headers, chatId, 'before');
    const messageId = created.body.data.id as string;

    const edited = await app.request
      .patch(`/api/chats/${chatId}/messages/${messageId}`)
      .set(alice.headers)
      .send({ body: 'after' });
    expect(edited.status).toBe(200);
    expect(edited.body.data.body).toBe('after');
    expect(edited.body.data.editedAt).not.toBeNull();

    const foreign = await app.request
      .patch(`/api/chats/${chatId}/messages/${messageId}`)
      .set(bob.headers)
      .send({ body: 'hijacked' });
    expect(foreign.status).toBe(403);
  });

  it('soft-deletes a message as a tombstone and only the sender can delete', async () => {
    const { alice, bob, chatId } = await createPair();
    const created = await send(alice.headers, chatId, 'goodbye');
    const messageId = created.body.data.id as string;

    const foreign = await app.request
      .delete(`/api/chats/${chatId}/messages/${messageId}`)
      .set(bob.headers);
    expect(foreign.status).toBe(403);

    const deleted = await app.request
      .delete(`/api/chats/${chatId}/messages/${messageId}`)
      .set(alice.headers);
    expect(deleted.status).toBe(204);

    const history = await app.request.get(`/api/chats/${chatId}/messages`).set(alice.headers);
    const tombstone = history.body.data.find((m: { id: string }) => m.id === messageId);
    expect(tombstone.body).toBeNull();
    expect(tombstone.deletedAt).not.toBeNull();
  });

  it('forwards a message to another chat the caller belongs to', async () => {
    const { alice, chatId } = await createPair();
    const charlie = await fixture.verifiedUser('Charlie');
    const targetChat = await fixture.openDirectChat(charlie.id, alice.headers);
    const original = await send(alice.headers, chatId, 'forward me');
    const originalId = original.body.data.id as string;

    const response = await app.request
      .post(`/api/chats/${chatId}/messages/${originalId}/forward`)
      .set(alice.headers)
      .send({ targetChatId: targetChat });

    expect(response.status).toBe(201);
    expect(response.body.data.chatId).toBe(targetChat);
    expect(response.body.data.body).toBe('forward me');
    expect(response.body.data.forwardedFromChatId).toBe(chatId);
    expect(response.body.data.forwardedFromMessageId).toBe(originalId);
  });

  it('rejects forwarding into a chat the caller does not belong to', async () => {
    const { alice, chatId } = await createPair();
    const charlie = await fixture.verifiedUser('Charlie');
    const dave = await fixture.verifiedUser('Dave');
    const targetChat = await fixture.openDirectChat(dave.id, charlie.headers);
    const original = await send(alice.headers, chatId, 'forward me');
    const originalId = original.body.data.id as string;

    const response = await app.request
      .post(`/api/chats/${chatId}/messages/${originalId}/forward`)
      .set(alice.headers)
      .send({ targetChatId: targetChat });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('NOT_CHAT_MEMBER');
  });

  it('bumps the chat activity time when a message is sent', async () => {
    const { alice, chatId } = await createPair();
    const charlie = await fixture.verifiedUser('Charlie');
    await new Promise((resolve) => setTimeout(resolve, 5));
    const newerChat = await fixture.openDirectChat(charlie.id, alice.headers);

    const before = await app.request.get('/api/chats').set(alice.headers);
    expect(before.body.data[0].id).toBe(newerChat);

    await send(alice.headers, chatId, 'revive the older chat');

    const after = await app.request.get('/api/chats').set(alice.headers);
    expect(after.body.data[0].id).toBe(chatId);
  });
});
