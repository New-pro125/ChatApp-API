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

  it('stores nullable read watermarks on chat members without a message foreign key', async () => {
    const columns = await app.pool.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_name = 'chat_members'
          AND column_name IN ('last_read_message_id', 'last_read_at')
        ORDER BY column_name`,
    );

    expect(columns.rows.map((row) => row.column_name)).toEqual([
      'last_read_at',
      'last_read_message_id',
    ]);
    expect(columns.rows.every((row) => row.is_nullable === 'YES')).toBe(true);

    const foreignKeys = await app.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM pg_constraint
        WHERE conrelid = 'public.chat_members'::regclass
          AND contype = 'f'
          AND confrelid = 'public.messages'::regclass`,
    );
    expect(foreignKeys.rows[0]?.count).toBe(0);
  });

  it('creates message_pins with a composite key and cascade FKs but no message FK', async () => {
    const columns = await app.pool.query<{ column_name: string; data_type: string }>(
      `SELECT column_name, data_type FROM information_schema.columns
       WHERE table_name = 'message_pins' ORDER BY ordinal_position`,
    );
    expect(columns.rows.map((row) => row.column_name)).toEqual([
      'chat_id',
      'message_id',
      'user_id',
      'pinned_at',
      'expires_at',
    ]);

    const keys = await app.pool.query<{ constraint_name: string; constraint_type: string }>(
      `SELECT constraint_name, constraint_type FROM information_schema.table_constraints
       WHERE table_name = 'message_pins' ORDER BY constraint_type, constraint_name`,
    );
    expect(keys.rows.map((row) => row.constraint_name)).toContain('message_pins_pkey');

    const indexes = await app.pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes
        WHERE tablename = 'message_pins' ORDER BY indexname`,
    );
    expect(indexes.rows.map((row) => row.indexname)).toContain('message_pins_expires_at_index');

    const fks = await app.pool.query<{ target: string; on_delete: string }>(
      `SELECT ccu.table_name AS target, rc.delete_rule AS on_delete
       FROM information_schema.table_constraints tc
       JOIN information_schema.referential_constraints rc
         ON rc.constraint_name = tc.constraint_name
       JOIN information_schema.constraint_column_usage ccu
         ON ccu.constraint_name = tc.constraint_name
       WHERE tc.table_name = 'message_pins' AND tc.constraint_type = 'FOREIGN KEY'`,
    );
    expect(fks.rows).toEqual(
      expect.arrayContaining([
        { target: 'chats', on_delete: 'CASCADE' },
        { target: 'users', on_delete: 'CASCADE' },
      ]),
    );
    expect(fks.rows.some((row) => row.target === 'messages')).toBe(false);
  });

  it('stores one pin per (chat, user, message) and orders pins by pinned_at', async () => {
    const first = await auth.createUser();
    const second = await auth.createUser();
    const chatId = await createDirectChat(first.id, second.id);
    await app.pool.query(
      `INSERT INTO messages (chat_id, sender_id, body) VALUES ($1, $2, 'pinned')`,
      [chatId, second.id],
    );
    const messageId = (
      await app.pool.query<{ id: string }>(`SELECT id FROM messages WHERE chat_id = $1`, [chatId])
    ).rows[0]?.id as string;

    await app.pool.query(
      `INSERT INTO message_pins (chat_id, message_id, user_id, expires_at)
       VALUES ($1, $2, $3, now() + interval '1 hour')`,
      [chatId, messageId, first.id],
    );
    await expect(
      app.pool.query(
        `INSERT INTO message_pins (chat_id, message_id, user_id, expires_at)
         VALUES ($1, $2, $3, now() + interval '1 hour')`,
        [chatId, messageId, first.id],
      ),
    ).rejects.toThrow(/message_pins_pkey/);

    const ordered = await app.pool.query<{ message_id: string }>(
      `SELECT message_id FROM message_pins
       WHERE chat_id = $1 AND user_id = $2 ORDER BY pinned_at DESC`,
      [chatId, first.id],
    );
    expect(ordered.rows.map((row) => row.message_id)).toEqual([messageId]);
  });

  it('stores per-member self-destruct presets and per-message expiries', async () => {
    const memberColumns = await app.pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'chat_members' ORDER BY ordinal_position`,
    );
    expect(memberColumns.rows.map((row) => row.column_name)).toContain('self_destruct_preset');

    const memberChecks = await app.pool.query<{ constraint_name: string }>(
      `SELECT constraint_name FROM information_schema.table_constraints
       WHERE table_name = 'chat_members' AND constraint_type = 'CHECK'`,
    );
    expect(memberChecks.rows.map((row) => row.constraint_name)).toContain(
      'chat_members_self_destruct_preset_check',
    );

    const messageColumns = await app.pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'messages' ORDER BY ordinal_position`,
    );
    expect(messageColumns.rows.map((row) => row.column_name)).toContain('expires_at');

    const messageChecks = await app.pool.query<{ constraint_name: string }>(
      `SELECT constraint_name FROM information_schema.table_constraints
       WHERE table_name = 'messages' AND constraint_type = 'CHECK'`,
    );
    expect(messageChecks.rows.map((row) => row.constraint_name)).toContain(
      'messages_expires_at_check',
    );

    const messageIndexes = await app.pool.query<{ indexname: string }>(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'messages' ORDER BY indexname`,
    );
    expect(messageIndexes.rows.map((row) => row.indexname)).toContain('messages_expires_at_index');
  });

  it('stores one private, length-checked draft per chat and author', async () => {
    const user = await auth.createUser();
    const peer = await auth.createUser();
    const chatId = await createDirectChat(user.id, peer.id);

    const columns = await app.pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name = 'message_drafts' ORDER BY ordinal_position`,
    );
    expect(columns.rows.map((row) => row.column_name)).toEqual([
      'chat_id',
      'user_id',
      'body',
      'created_at',
      'updated_at',
    ]);

    const constraints = await app.pool.query<{ constraint_name: string }>(
      `SELECT constraint_name FROM information_schema.table_constraints
       WHERE table_name = 'message_drafts' ORDER BY constraint_name`,
    );
    const names = constraints.rows.map((row) => row.constraint_name);
    expect(names).toContain('message_drafts_pkey');
    expect(names).toContain('message_drafts_body_check');

    const foreignKeys = await app.pool.query<{ delete_rule: string }>(
      `SELECT rc.delete_rule FROM information_schema.referential_constraints rc
       JOIN information_schema.table_constraints tc ON tc.constraint_name = rc.constraint_name
       WHERE rc.constraint_schema = 'public' AND tc.table_schema = 'public'
         AND tc.table_name = 'message_drafts'`,
    );
    expect(foreignKeys.rows).toHaveLength(2);
    expect(foreignKeys.rows.every((row) => row.delete_rule === 'CASCADE')).toBe(true);

    await app.pool.query(
      `INSERT INTO message_drafts (chat_id, user_id, body) VALUES ($1, $2, $3)`,
      [chatId, user.id, 'hello'],
    );

    await expect(
      app.pool.query(`INSERT INTO message_drafts (chat_id, user_id, body) VALUES ($1, $2, '')`, [
        chatId,
        peer.id,
      ]),
    ).rejects.toThrow(/message_drafts_body_check/);

    await expect(
      app.pool.query(
        `INSERT INTO message_drafts (chat_id, user_id, body) VALUES ($1, $2, $3)`,
        [chatId, peer.id, 'x'.repeat(4097)],
      ),
    ).rejects.toThrow(/message_drafts_body_check/);

    await app.pool.query(`DELETE FROM chats WHERE id = $1`, [chatId]);
    const remaining = await app.pool.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM message_drafts WHERE chat_id = $1`,
      [chatId],
    );
    expect(remaining.rows[0]?.count).toBe(0);
  });
});
