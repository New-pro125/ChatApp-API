import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { expectError, expectSuccess } from '../../helpers/assertions.js';
import { TestApp } from '../../helpers/test-app.js';
import { type ApiUser, MessagingApiFixture } from './messaging-api.fixture.js';

interface ReadWatermark {
  chatId: string;
  lastReadMessageId: string | null;
  lastReadAt: string | null;
}

describe('Read receipts', () => {
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

  function send(headers: Record<string, string>, chatId: string, body: string) {
    return app.request.post(`/api/chats/${chatId}/messages`).set(headers).send({ body });
  }

  function markRead(headers: Record<string, string>, chatId: string, body: object = {}) {
    return app.request.post(`/api/chats/${chatId}/read`).set(headers).send(body);
  }

  it('marks a chat read up to the newest message when no messageId is given', async () => {
    const { alice, bob, chatId } = await createPair();
    await send(bob.headers, chatId, 'one');
    const newest = await send(bob.headers, chatId, 'two');
    const newestId = newest.body.data.id as string;

    const data = expectSuccess<ReadWatermark>(await markRead(alice.headers, chatId), 200);

    expect(data.chatId).toBe(chatId);
    expect(data.lastReadMessageId).toBe(newestId);
    expect(data.lastReadAt).not.toBeNull();
  });

  it('marks a chat read up to a specific message and never rewinds', async () => {
    const { alice, bob, chatId } = await createPair();
    const first = await send(bob.headers, chatId, 'one');
    const firstId = first.body.data.id as string;
    const second = await send(bob.headers, chatId, 'two');
    const secondId = second.body.data.id as string;

    const atFirst = expectSuccess<ReadWatermark>(
      await markRead(alice.headers, chatId, { messageId: firstId }),
      200,
    );
    expect(atFirst.lastReadMessageId).toBe(firstId);

    const atSecond = expectSuccess<ReadWatermark>(
      await markRead(alice.headers, chatId, { messageId: secondId }),
      200,
    );
    const stale = expectSuccess<ReadWatermark>(
      await markRead(alice.headers, chatId, { messageId: firstId }),
      200,
    );

    expect(stale.lastReadMessageId).toBe(secondId);
    expect(stale.lastReadAt).toBe(atSecond.lastReadAt);
  });

  it('accepts mark-read on an empty chat', async () => {
    const { alice, chatId } = await createPair();

    const data = expectSuccess<ReadWatermark>(await markRead(alice.headers, chatId), 200);

    expect(data.chatId).toBe(chatId);
    expect(data.lastReadMessageId).toBeNull();
    expect(data.lastReadAt).toBeNull();
  });

  it('rejects a messageId from another chat', async () => {
    const { alice, chatId } = await createPair();
    const charlie = await fixture.verifiedUser('Charlie');
    const otherChatId = await fixture.openDirectChat(alice.id, charlie.headers);
    const foreign = await send(charlie.headers, otherChatId, 'foreign');
    const foreignId = foreign.body.data.id as string;

    const response = await markRead(alice.headers, chatId, { messageId: foreignId });

    expectError(response, 404, 'NOT_FOUND');
  });

  it('rejects malformed, unauthenticated, unverified, and non-member calls', async () => {
    const { alice, chatId } = await createPair();
    const charlie = await fixture.verifiedUser('Charlie');
    const unverified = await fixture.unverifiedUser('Unverified');

    expectError(
      await markRead(alice.headers, chatId, { messageId: 'not-a-uuid' }),
      400,
      'VALIDATION_ERROR',
    );
    expectError(await app.request.post(`/api/chats/${chatId}/read`).send({}), 401, 'UNAUTHORIZED');
    expectError(await markRead(unverified.headers, chatId), 403, 'EMAIL_NOT_VERIFIED');
    expectError(await markRead(charlie.headers, chatId), 403, 'NOT_CHAT_MEMBER');
  });

  it('allows mark-read in a secret chat without touching its ciphertext payload', async () => {
    const alice = await fixture.verifiedUser('Alice Secret');
    const bob = await fixture.verifiedUser('Bob Secret');
    await fixture.registerDevice(alice);
    const bobDevice = await fixture.registerDevice(bob);
    const chatId = await fixture.openSecretChat(bob.id, alice.headers);
    const sent = await app.request
      .post(`/api/chats/${chatId}/secret-messages`)
      .set(alice.headers)
      .send({
        recipientDeviceId: bobDevice.deviceId,
        ciphertext: Buffer.from('ciphertext').toString('base64url'),
        nonce: 'A'.repeat(16),
        ephemeralPublicKey: 'A'.repeat(43),
      });
    expect(sent.status).toBe(201);
    const messageId = sent.body.data.id as string;

    const data = expectSuccess<ReadWatermark>(
      await markRead(bob.headers, chatId, { messageId }),
      200,
    );
    expect(data.lastReadMessageId).toBe(messageId);

    const after = await app.request.get(`/api/chats/${chatId}/messages`).set(alice.headers);
    expect(after.body.data[0].ciphertext).toBe(sent.body.data.ciphertext);
    expect(after.body.data[0].nonce).toBe(sent.body.data.nonce);
    expect(after.body.data[0].body).toBeNull();
  });
});
