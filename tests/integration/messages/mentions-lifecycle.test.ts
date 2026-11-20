import { Container } from 'inversify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { MessageMentionRepository } from '@/modules/messages/logic/ports/message-mention.repository.js';
import type { SelfDestructCleanupWorker } from '@/modules/messages/logic/self-destruct-cleanup.worker.js';
import { MessagesContainer } from '@/modules/messages/messages.container.js';
import { MESSAGES_TYPES } from '@/modules/messages/messages.types.js';
import { expectNoContent, expectSuccess } from '../../helpers/assertions.js';
import { TestApp } from '../../helpers/test-app.js';
import { MessagingApiFixture, type ApiUser } from './messaging-api.fixture.js';

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

describe('mention lifecycle', () => {
  let app: TestApp;
  let fixture: MessagingApiFixture;
  let mentions: MessageMentionRepository;
  let worker: SelfDestructCleanupWorker;

  beforeAll(async () => {
    app = await TestApp.create();
    fixture = new MessagingApiFixture(app);
    const container = new MessagesContainer(new Container({ parent: app.container }));
    mentions = container.get<MessageMentionRepository>(MESSAGES_TYPES.MessageMentionRepository);
    worker = container.get<SelfDestructCleanupWorker>(MESSAGES_TYPES.SelfDestructCleanupWorker);
  });

  afterAll(async () => {
    await worker.close();
    await app.close();
  });

  beforeEach(async () => {
    await app.clearDatabase();
    fixture.auth.emails.clear();
  });

  async function pair(): Promise<{ alice: ApiUser; bob: ApiUser; chatId: string }> {
    const alice = await fixture.verifiedUser('Alice');
    const bob = await fixture.verifiedUser('Bob');
    const chatId = await fixture.openDirectChat(bob.id, alice.headers);
    await app.pool.query(`UPDATE users SET username = $1 WHERE id = $2`, ['alice_01', alice.id]);
    await app.pool.query(`UPDATE users SET username = $1 WHERE id = $2`, ['bob_01', bob.id]);
    return { alice, bob, chatId };
  }

  async function inbox(user: ApiUser): Promise<MentionItem[]> {
    const response = await app.request.get('/api/chats/mentions').set(user.headers);
    return expectSuccess<{ unreadCount: number; mentions: MentionItem[] }>(response, 200).mentions;
  }

  async function sentBody(chatId: string, user: ApiUser, body: string) {
    const response = await app.request
      .post(`/api/chats/${chatId}/messages`)
      .set(user.headers)
      .send({ body });
    return expectSuccess<{ id: string; body: string; mentions: unknown[] }>(response, 201);
  }

  it('syncs on send, recomputes on edit, and hides on delete', async () => {
    const { alice, bob, chatId } = await pair();
    const sent = await sentBody(chatId, alice, 'hello @bob_01');

    expect(sent.body).toBe('hello @bob_01');
    expect(sent.mentions).toEqual([{ userId: bob.id, username: 'bob_01', displayName: 'Bob' }]);
    expect(await inbox(bob)).toHaveLength(1);

    await app.request
      .patch(`/api/chats/${chatId}/messages/${sent.id}`)
      .set(alice.headers)
      .send({ body: 'no names now' });
    expect(await inbox(bob)).toEqual([]);

    await app.request
      .patch(`/api/chats/${chatId}/messages/${sent.id}`)
      .set(alice.headers)
      .send({ body: 'again @BOB_01' });
    expect(await inbox(bob)).toHaveLength(1);

    expectNoContent(
      await app.request.delete(`/api/chats/${chatId}/messages/${sent.id}`).set(alice.headers),
    );
    expect(await inbox(bob)).toEqual([]);
  });

  it('syncs forwarded text into the target chat', async () => {
    const { alice, bob, chatId } = await pair();
    const third = await fixture.verifiedUser('Third');
    await app.pool.query(`UPDATE users SET username = $1 WHERE id = $2`, ['third_01', third.id]);
    const targetChatId = await fixture.openDirectChat(third.id, alice.headers);
    const source = await sentBody(chatId, alice, 'forward @third_01');

    const forwarded = expectSuccess<{
      id: string;
      mentions: Array<{ userId: string; username: string | null; displayName: string }>;
    }>(
      await app.request
        .post(`/api/chats/${chatId}/messages/${source.id}/forward`)
        .set(alice.headers)
        .send({ targetChatId }),
      201,
    );

    expect(forwarded.mentions).toEqual([
      { userId: third.id, username: 'third_01', displayName: 'Third' },
    ]);
    const thirdInbox = await inbox(third);
    expect(thirdInbox).toHaveLength(1);
    expect(thirdInbox[0]?.messageId).toBe(forwarded.id);
    expect(thirdInbox[0]?.chatId).toBe(targetChatId);
    expect(await inbox(bob)).toEqual([]);

    const targetHistory = expectSuccess<
      Array<{
        id: string;
        mentions: Array<{ userId: string; username: string | null; displayName: string }>;
      }>
    >(
      await app.request.get(`/api/chats/${targetChatId}/messages`).set(alice.headers),
      200,
    );
    expect(targetHistory.find((message) => message.id === forwarded.id)?.mentions).toEqual([
      { userId: third.id, username: 'third_01', displayName: 'Third' },
    ]);
  });

  it('hides mentions when a message is deleted or scrubbed', async () => {
    const { alice, bob, chatId } = await pair();
    const sent = await sentBody(chatId, alice, 'expiring @bob_01');

    await app.pool.query(
      `UPDATE messages SET created_at = now() - interval '2 seconds',
       expires_at = now() - interval '1 second'
       WHERE chat_id = $1 AND id = $2`,
      [chatId, sent.id],
    );
    expect((await worker.process()).scrubbed).toBe(1);

    expect(await inbox(bob)).toEqual([]);
    const rows = await mentions.list(bob.id, { limit: 10 });
    expect(rows).toEqual([]);
  });
});
