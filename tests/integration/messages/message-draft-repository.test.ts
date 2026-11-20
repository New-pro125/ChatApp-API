import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { MessageDraftRepository } from '@/modules/messages/logic/ports/message-draft.repository.js';
import { MessagesContainer } from '@/modules/messages/messages.container.js';
import { MESSAGES_TYPES } from '@/modules/messages/messages.types.js';
import { AuthFixture } from '../../fixtures/auth.fixture.js';
import { TestApp } from '../../helpers/test-app.js';

describe('MessageDraftRepository', () => {
  let app: TestApp;
  let auth: AuthFixture;
  let drafts: MessageDraftRepository;

  beforeAll(async () => {
    app = await TestApp.create();
    auth = new AuthFixture(app);
    const container = new MessagesContainer(app.container);
    drafts = container.get<MessageDraftRepository>(MESSAGES_TYPES.MessageDraftRepository);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await app.clearDatabase();
    auth.emails.clear();
  });

  async function chatFor(userId: string): Promise<string> {
    const result = await app.pool.query<{ id: string }>(
      `INSERT INTO chats (type, direct_key) VALUES ('direct', $1) RETURNING id`,
      [randomUUID()],
    );
    const chatId = result.rows[0]?.id;

    if (!chatId) {
      throw new Error('Could not create a chat');
    }

    await app.pool.query(`INSERT INTO chat_members (chat_id, user_id) VALUES ($1, $2)`, [
      chatId,
      userId,
    ]);

    return chatId;
  }

  it('creates, overwrites, and deletes one draft per chat and user', async () => {
    const user = await auth.createUser();
    const chatId = await chatFor(user.id);
    const first = new Date('2026-11-20T10:00:00.000Z');
    const second = new Date('2026-11-20T11:00:00.000Z');

    expect(await drafts.find(chatId, user.id)).toBeNull();

    const created = await drafts.upsert(chatId, user.id, 'first', first);
    expect(created).toMatchObject({ chatId, userId: user.id, body: 'first' });
    expect(created.createdAt.toISOString()).toBe(first.toISOString());
    expect(created.updatedAt.toISOString()).toBe(first.toISOString());

    const updated = await drafts.upsert(chatId, user.id, 'second', second);
    expect(updated.body).toBe('second');
    expect(updated.createdAt.toISOString()).toBe(first.toISOString());
    expect(updated.updatedAt.toISOString()).toBe(second.toISOString());
    expect((await drafts.find(chatId, user.id))?.body).toBe('second');

    expect(await drafts.delete(chatId, user.id)).toBe(true);
    expect(await drafts.delete(chatId, user.id)).toBe(false);
    expect(await drafts.find(chatId, user.id)).toBeNull();
  });

  it('keeps drafts of different users in the same chat separate', async () => {
    const first = await auth.createUser();
    const second = await auth.createUser();
    const chatId = await chatFor(first.id);
    await app.pool.query(`INSERT INTO chat_members (chat_id, user_id) VALUES ($1, $2)`, [
      chatId,
      second.id,
    ]);

    const now = new Date();
    await drafts.upsert(chatId, first.id, 'mine', now);
    await drafts.upsert(chatId, second.id, 'theirs', now);

    expect((await drafts.find(chatId, first.id))?.body).toBe('mine');
    expect((await drafts.find(chatId, second.id))?.body).toBe('theirs');
  });
});
