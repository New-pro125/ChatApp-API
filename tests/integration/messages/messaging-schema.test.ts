import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuthFixture } from '../../fixtures/auth.fixture.js';
import { TestApp } from '../../helpers/test-app.js';

/**
 * Schema-level checks for the messaging tables.
 *
 * These use raw SQL on purpose: they assert the physical shape the Drizzle
 * schema cannot express (hash partitioning) and the row invariants the
 * database enforces, independent of the repository layer.
 */
describe('Messaging schema', () => {
  let app: TestApp;
  let auth: AuthFixture;

  beforeAll(async () => {
    app = await TestApp.create();
    auth = new AuthFixture(app);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await app.clearDatabase();
    auth.emails.clear();
  });

  async function createDirectChat(firstUserId: string, secondUserId: string): Promise<string> {
    const directKey = [firstUserId, secondUserId].sort().join(':');
    const result = await app.pool.query<{ id: string }>(
      `INSERT INTO chats (type, direct_key) VALUES ('direct', $1) RETURNING id`,
      [directKey],
    );
    const chatId = result.rows[0]?.id as string;

    await app.pool.query(`INSERT INTO chat_members (chat_id, user_id) VALUES ($1, $2), ($1, $3)`, [
      chatId,
      firstUserId,
      secondUserId,
    ]);

    return chatId;
  }

  it('stores messages as a hash-partitioned table with sixteen partitions', async () => {
    const kind = await app.pool.query<{ relkind: string }>(
      `SELECT relkind FROM pg_class WHERE oid = 'public.messages'::regclass`,
    );
    expect(kind.rows[0]?.relkind).toBe('p');

    const partitions = await app.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM pg_inherits WHERE inhparent = 'public.messages'::regclass`,
    );
    expect(partitions.rows[0]?.count).toBe(16);
  });

  it('routes every row of one chat to a single partition', async () => {
    const sender = await auth.createUser();
    const recipient = await auth.createUser();
    const chatId = await createDirectChat(sender.id, recipient.id);

    for (let index = 0; index < 12; index += 1) {
      await app.pool.query(`INSERT INTO messages (chat_id, sender_id, body) VALUES ($1, $2, $3)`, [
        chatId,
        sender.id,
        `message ${index}`,
      ]);
    }

    const spread = await app.pool.query<{ partitions: number }>(
      `SELECT count(DISTINCT tableoid)::int AS partitions FROM messages WHERE chat_id = $1`,
      [chatId],
    );
    expect(spread.rows[0]?.partitions).toBe(1);
  });

  it('rejects a second direct chat for the same user pair', async () => {
    const first = await auth.createUser();
    const second = await auth.createUser();
    await createDirectChat(first.id, second.id);

    await expect(createDirectChat(first.id, second.id)).rejects.toThrow(/chats_direct_key_unique/);
  });

  it('rejects a direct chat that carries a title', async () => {
    await expect(
      app.pool.query(`INSERT INTO chats (type, title, direct_key) VALUES ('direct', 'Nope', 'k')`),
    ).rejects.toThrow(/chats_shape_check/);
  });

  it('rejects a group chat without a title', async () => {
    await expect(app.pool.query(`INSERT INTO chats (type) VALUES ('group')`)).rejects.toThrow(
      /chats_shape_check/,
    );
  });

  it('rejects duplicate membership for a chat', async () => {
    const first = await auth.createUser();
    const second = await auth.createUser();
    const chatId = await createDirectChat(first.id, second.id);

    await expect(
      app.pool.query(`INSERT INTO chat_members (chat_id, user_id) VALUES ($1, $2)`, [
        chatId,
        first.id,
      ]),
    ).rejects.toThrow(/chat_members_pkey/);
  });

  it('cascades messages and members when a chat is deleted', async () => {
    const sender = await auth.createUser();
    const recipient = await auth.createUser();
    const chatId = await createDirectChat(sender.id, recipient.id);
    await app.pool.query(
      `INSERT INTO messages (chat_id, sender_id, body) VALUES ($1, $2, 'hello')`,
      [chatId, sender.id],
    );

    await app.pool.query(`DELETE FROM chats WHERE id = $1`, [chatId]);

    const remainingMessages = await app.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM messages WHERE chat_id = $1`,
      [chatId],
    );
    const remainingMembers = await app.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM chat_members WHERE chat_id = $1`,
      [chatId],
    );
    expect(remainingMessages.rows[0]?.count).toBe(0);
    expect(remainingMembers.rows[0]?.count).toBe(0);
  });

  it('rejects a message body longer than 4096 characters', async () => {
    const sender = await auth.createUser();
    const recipient = await auth.createUser();
    const chatId = await createDirectChat(sender.id, recipient.id);

    await expect(
      app.pool.query(`INSERT INTO messages (chat_id, sender_id, body) VALUES ($1, $2, $3)`, [
        chatId,
        sender.id,
        'x'.repeat(4097),
      ]),
    ).rejects.toThrow(/messages_body_length_check/);
  });

  it('rejects a text message without a body', async () => {
    const sender = await auth.createUser();
    const recipient = await auth.createUser();
    const chatId = await createDirectChat(sender.id, recipient.id);

    await expect(
      app.pool.query(`INSERT INTO messages (chat_id, sender_id, type) VALUES ($1, $2, 'text')`, [
        chatId,
        sender.id,
      ]),
    ).rejects.toThrow(/messages_text_body_check/);
  });

  it('scopes the primary key to the chat, not the message id alone', async () => {
    const sender = await auth.createUser();
    const other = await auth.createUser();
    const firstChat = await createDirectChat(sender.id, other.id);
    const third = await auth.createUser();
    const secondChat = await createDirectChat(sender.id, third.id);
    const sharedId = randomUUID();

    await app.pool.query(
      `INSERT INTO messages (id, chat_id, sender_id, body) VALUES ($1, $2, $3, 'first')`,
      [sharedId, firstChat, sender.id],
    );
    await app.pool.query(
      `INSERT INTO messages (id, chat_id, sender_id, body) VALUES ($1, $2, $3, 'second')`,
      [sharedId, secondChat, sender.id],
    );

    await expect(
      app.pool.query(
        `INSERT INTO messages (id, chat_id, sender_id, body) VALUES ($1, $2, $3, 'dup')`,
        [sharedId, firstChat, sender.id],
      ),
    ).rejects.toThrow(/messages_p\d+_pkey/);
  });
});
