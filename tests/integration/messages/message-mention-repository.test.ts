import { Container } from 'inversify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { MessageMentionRepository } from '@/modules/messages/logic/ports/message-mention.repository.js';
import { MessagesContainer } from '@/modules/messages/messages.container.js';
import { MESSAGES_TYPES } from '@/modules/messages/messages.types.js';
import { expectSuccess } from '../../helpers/assertions.js';
import { TestApp } from '../../helpers/test-app.js';
import { MessagingApiFixture } from './messaging-api.fixture.js';

describe('MessageMentionRepository', () => {
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

  async function pairWithNames() {
    const alice = await fixture.verifiedUser('Alice');
    const bob = await fixture.verifiedUser('Bob');
    const chatId = await fixture.openDirectChat(bob.id, alice.headers);
    await app.pool.query(`UPDATE users SET username = $1 WHERE id = $2`, ['alice_01', alice.id]);
    await app.pool.query(`UPDATE users SET username = $1 WHERE id = $2`, ['bob_01', bob.id]);
    return { alice, bob, chatId };
  }

  async function send(chatId: string, headers: Record<string, string>, body: string) {
    const response = await app.request
      .post(`/api/chats/${chatId}/messages`)
      .set(headers)
      .send({ body });
    return expectSuccess<{ id: string }>(response, 201).id;
  }

  it('sync retains retained rows and hard-deletes removed rows', async () => {
    const { alice, bob, chatId } = await pairWithNames();
    const messageId = await send(chatId, alice.headers, 'hello @bob_01');

    await mentions.sync(chatId, messageId, [alice.id, bob.id], new Date('2026-11-20T10:00:00Z'));
    expect(await mentions.countUnread(bob.id)).toBe(1);

    const first = await mentions.list(bob.id, { limit: 10 });
    expect(first[0]?.mentionedByUserId).toBe(alice.id);
    const row = first[0];
    if (!row) {
      throw new Error('missing mention row');
    }

    await mentions.markRead(bob.id, [row.id], new Date('2026-11-20T11:00:00Z'));
    expect(await mentions.countUnread(bob.id)).toBe(0);

    await mentions.sync(chatId, messageId, [bob.id], new Date('2026-11-20T12:00:00Z'));
    const retained = await mentions.list(bob.id, { limit: 10 });
    expect(retained).toHaveLength(1);
    expect(retained[0]?.readAt).not.toBeNull();

    await mentions.sync(chatId, messageId, [alice.id], new Date('2026-11-20T13:00:00Z'));
    expect(await mentions.list(bob.id, { limit: 10 })).toEqual([]);
    expect(await mentions.countUnread(alice.id)).toBe(1);
  });

  it('hides only the named message', async () => {
    const { alice, bob, chatId } = await pairWithNames();
    const firstId = await send(chatId, alice.headers, 'first @bob_01');
    const secondId = await send(chatId, alice.headers, 'second @bob_01');
    await mentions.sync(chatId, firstId, [bob.id], new Date());
    await mentions.sync(chatId, secondId, [bob.id], new Date());

    await mentions.hideForMessage(chatId, firstId, new Date());
    await mentions.hideForMessage(chatId, firstId, new Date());

    const rows = await mentions.list(bob.id, { limit: 10 });
    expect(rows.map((row) => row.messageId)).toEqual([secondId]);
    expect(await mentions.countUnread(bob.id)).toBe(1);
  });

  it('keysets by id and enforces caller scope', async () => {
    const { alice, bob, chatId } = await pairWithNames();
    const ids = [
      await send(chatId, alice.headers, 'one @bob_01'),
      await send(chatId, alice.headers, 'two @bob_01'),
      await send(chatId, alice.headers, 'three @bob_01'),
    ];
    for (const id of ids) {
      await mentions.sync(chatId, id, [bob.id], new Date());
    }

    const firstPage = await mentions.list(bob.id, { limit: 2 });
    expect(firstPage.map((row) => row.messageId)).toEqual([ids[2], ids[1]]);
    const secondPage = await mentions.list(bob.id, {
      limit: 2,
      beforeId: firstPage[1]?.id,
    });
    expect(secondPage.map((row) => row.messageId)).toEqual([ids[0]]);

    const row = firstPage[0];
    if (!row) {
      throw new Error('missing mention row');
    }
    expect(await mentions.findById(alice.id, row.id)).toBeNull();
    expect(await mentions.markRead(alice.id, [row.id], new Date())).toBe(0);
    expect((await mentions.findById(bob.id, row.id))?.readAt).toBeNull();
  });

  it('serializes overlapping syncs on the message row', async () => {
    const { alice, bob, chatId } = await pairWithNames();
    const carol = await fixture.verifiedUser('Carol');
    const dave = await fixture.verifiedUser('Dave');
    const messageId = await send(chatId, alice.headers, 'hello @bob_01');
    await mentions.sync(chatId, messageId, [bob.id], new Date('2026-11-20T10:00:00Z'));

    const client = await app.pool.connect();
    const settled = (promise: Promise<void>): Promise<'done' | 'rejected'> =>
      promise.then(
        () => 'done',
        () => 'rejected',
      );

    try {
      await client.query('BEGIN');
      await client.query('SELECT 1 FROM messages WHERE chat_id = $1 AND id = $2 FOR SHARE', [
        chatId,
        messageId,
      ]);

      const first = settled(
        mentions.sync(chatId, messageId, [carol.id], new Date('2026-11-20T11:00:00Z')),
      );
      const second = settled(
        mentions.sync(chatId, messageId, [bob.id, dave.id], new Date('2026-11-20T12:00:00Z')),
      );
      const race = await Promise.race([
        Promise.all([first, second]).then(() => 'settled' as const),
        new Promise<'waiting'>((resolve) => {
          setTimeout(() => resolve('waiting'), 500);
        }),
      ]);
      expect(race).toBe('waiting');

      await client.query('COMMIT');
      expect(await Promise.all([first, second])).toEqual(['done', 'done']);
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }

    const byMessage = await mentions.listForMessages(chatId, [messageId]);
    const targets = (byMessage.get(messageId) ?? []).map((row) => row.mentionedUserId).sort();
    const expected = [[carol.id].sort(), [bob.id, dave.id].sort()];
    expect(
      expected.some((candidate) => JSON.stringify(candidate) === JSON.stringify(targets)),
    ).toBe(true);
  });
});
