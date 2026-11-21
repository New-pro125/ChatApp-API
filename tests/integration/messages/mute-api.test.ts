import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { expectError, expectSuccess } from '../../helpers/assertions.js';
import { TestApp } from '../../helpers/test-app.js';
import { MessagingApiFixture } from './messaging-api.fixture.js';

interface MuteResult {
  chatId: string;
  muted: boolean;
  muteExpiresAt: string | null;
}

describe('mute chat API', () => {
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
  });

  const setMute = async (
    headers: Record<string, string>,
    chatId: string,
    preset: string | null,
  ): Promise<MuteResult> =>
    expectSuccess<MuteResult>(
      await app.request.patch(`/api/chats/${chatId}/mute`).set(headers).send({ preset }),
    );

  it('sets and clears a timed mute', async () => {
    const alice = await fixture.verifiedUser('Alice');
    const bob = await fixture.verifiedUser('Bob');
    const chatId = await fixture.openDirectChat(bob.id, alice.headers);

    const timed = await setMute(alice.headers, chatId, '8h');
    expect(timed.chatId).toBe(chatId);
    expect(timed.muted).toBe(true);
    expect(timed.muteExpiresAt).not.toBeNull();

    const forever = await setMute(alice.headers, chatId, 'forever');
    expect(forever.muted).toBe(true);
    expect(forever.muteExpiresAt).toBeNull();

    const cleared = await setMute(alice.headers, chatId, null);
    expect(cleared.muted).toBe(false);
    expect(cleared.muteExpiresAt).toBeNull();
  });

  it('rejects non-members, invalid presets, unverified callers, and anonymous callers', async () => {
    const alice = await fixture.verifiedUser('Alice');
    const bob = await fixture.verifiedUser('Bob');
    const outsider = await fixture.verifiedUser('Outsider');
    const unverified = await fixture.unverifiedUser('Unverified');
    const chatId = await fixture.openDirectChat(bob.id, alice.headers);

    expectError(
      await app.request
        .patch(`/api/chats/${chatId}/mute`)
        .set(outsider.headers)
        .send({ preset: '8h' }),
      403,
      'NOT_CHAT_MEMBER',
    );
    expectError(
      await app.request
        .patch(`/api/chats/${chatId}/mute`)
        .set(alice.headers)
        .send({ preset: '12h' }),
      400,
      'VALIDATION_ERROR',
    );
    expectError(
      await app.request.patch(`/api/chats/${chatId}/mute`).set(alice.headers).send({}),
      400,
      'VALIDATION_ERROR',
    );
    expectError(
      await app.request
        .patch(`/api/chats/${chatId}/mute`)
        .set(unverified.headers)
        .send({ preset: '8h' }),
      403,
      'EMAIL_NOT_VERIFIED',
    );
    expectError(
      await app.request.patch(`/api/chats/${chatId}/mute`).send({ preset: '8h' }),
      401,
      'UNAUTHORIZED',
    );
  });

  it('projects mute state only to the caller and hides expired mutes', async () => {
    const alice = await fixture.verifiedUser('Alice');
    const bob = await fixture.verifiedUser('Bob');
    const chatId = await fixture.openDirectChat(bob.id, alice.headers);

    await setMute(alice.headers, chatId, 'forever');

    const aliceChats = expectSuccess<
      Array<{ id: string; muted: boolean; muteExpiresAt: string | null }>
    >(await app.request.get('/api/chats').set(alice.headers));
    const aliceChat = aliceChats.find((chat) => chat.id === chatId);
    expect(aliceChat?.muted).toBe(true);
    expect(aliceChat?.muteExpiresAt).toBeNull();

    const bobChats = expectSuccess<
      Array<{ id: string; muted: boolean; muteExpiresAt: string | null }>
    >(await app.request.get('/api/chats').set(bob.headers));
    const bobChat = bobChats.find((chat) => chat.id === chatId);
    expect(bobChat?.muted).toBe(false);
    expect(bobChat?.muteExpiresAt).toBeNull();

    const expiredAt = new Date('2026-11-19T10:00:00.000Z');
    const expiredUntil = new Date('2026-11-20T09:00:00.000Z');
    await app.pool.query(
      `UPDATE chat_members SET muted_at = $3, muted_until = $4
       WHERE chat_id = $1 AND user_id = $2`,
      [chatId, alice.id, expiredAt, expiredUntil],
    );

    const afterExpiry = expectSuccess<
      Array<{ id: string; muted: boolean; muteExpiresAt: string | null }>
    >(await app.request.get('/api/chats').set(alice.headers));
    const expiredChat = afterExpiry.find((chat) => chat.id === chatId);
    expect(expiredChat?.muted).toBe(false);
    expect(expiredChat?.muteExpiresAt).toBeNull();

    const stored = await app.pool.query<{ muted_at: Date | null; muted_until: Date | null }>(
      `SELECT muted_at, muted_until FROM chat_members WHERE chat_id = $1 AND user_id = $2`,
      [chatId, alice.id],
    );
    expect(stored.rows[0]?.muted_at).not.toBeNull();
    expect(stored.rows[0]?.muted_until).not.toBeNull();
  });
});
