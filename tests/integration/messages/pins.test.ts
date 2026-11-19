import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { expectError, expectNoContent, expectSuccess } from '../../helpers/assertions.js';
import { TestApp } from '../../helpers/test-app.js';
import { MessagingApiFixture } from './messaging-api.fixture.js';

interface PinResult {
  messageId: string;
  pinnedAt: string;
}

describe('Pinned messages HTTP API', () => {
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

  async function pair() {
    const alice = await fixture.verifiedUser('Alice');
    const bob = await fixture.verifiedUser('Bob');
    const chatId = await fixture.openDirectChat(bob.id, alice.headers);
    return { alice, bob, chatId };
  }

  async function send(
    headers: Record<string, string>,
    chatId: string,
    body: string,
  ): Promise<string> {
    const created = expectSuccess<{ id: string }>(
      await app.request.post(`/api/chats/${chatId}/messages`).set(headers).send({ body }),
      201,
    );
    return created.id;
  }

  function pin(headers: Record<string, string>, chatId: string, messageId: string) {
    return app.request.post(`/api/chats/${chatId}/messages/${messageId}/pin`).set(headers);
  }

  it('pins idempotently, lists newest-first, and unpins to 204', async () => {
    const { alice, bob, chatId } = await pair();
    const first = await send(bob.headers, chatId, 'first');
    const second = await send(bob.headers, chatId, 'second');

    const firstPin = expectSuccess<PinResult>(await pin(alice.headers, chatId, first), 201);
    expect(firstPin.messageId).toBe(first);
    const duplicate = expectSuccess<PinResult>(await pin(alice.headers, chatId, first), 201);
    expect(duplicate.pinnedAt).toBe(firstPin.pinnedAt);
    await pin(alice.headers, chatId, second);

    const listed = expectSuccess<Array<{ id: string; pinnedAt: string | null }>>(
      await app.request.get(`/api/chats/${chatId}/pins`).set(alice.headers),
      200,
    );
    expect(listed.map((message) => message.id)).toEqual([second, first]);
    expect(listed.every((message) => message.pinnedAt !== null)).toBe(true);

    expectNoContent(
      await app.request.delete(`/api/chats/${chatId}/messages/${first}/pin`).set(alice.headers),
    );
    expectNoContent(
      await app.request.delete(`/api/chats/${chatId}/messages/${first}/pin`).set(alice.headers),
    );
    const after = expectSuccess<Array<{ id: string }>>(
      await app.request.get(`/api/chats/${chatId}/pins`).set(alice.headers),
      200,
    );
    expect(after.map((message) => message.id)).toEqual([second]);
  });

  it('keeps pins private between participants', async () => {
    const { alice, bob, chatId } = await pair();
    const messageId = await send(alice.headers, chatId, 'mine');
    await pin(alice.headers, chatId, messageId);

    const bobPins = expectSuccess<Array<{ id: string }>>(
      await app.request.get(`/api/chats/${chatId}/pins`).set(bob.headers),
      200,
    );
    expect(bobPins).toEqual([]);
    const bobHistory = expectSuccess<Array<{ id: string; pinnedAt: string | null }>>(
      await app.request.get(`/api/chats/${chatId}/messages`).set(bob.headers),
      200,
    );
    expect(bobHistory.find((message) => message.id === messageId)?.pinnedAt).toBeNull();
  });

  it('rejects the eleventh pin with 409 CONFLICT', async () => {
    const { alice, bob, chatId } = await pair();
    const ids: string[] = [];
    for (let index = 0; index < 11; index += 1) {
      ids.push(await send(bob.headers, chatId, `message ${index}`));
    }
    for (const id of ids.slice(0, 10)) {
      expectSuccess(await pin(alice.headers, chatId, id), 201);
    }
    expectError(await pin(alice.headers, chatId, ids[10] as string), 409, 'CONFLICT');
  });

  it('rejects foreign, deleted, and malformed targets', async () => {
    const { alice, chatId } = await pair();
    const outsider = await fixture.verifiedUser('Charlie');
    const otherChatId = await fixture.openDirectChat(outsider.id, alice.headers);
    const foreignId = await send(outsider.headers, otherChatId, 'foreign');
    const ownId = await send(alice.headers, chatId, 'own');

    expectError(await pin(alice.headers, chatId, foreignId), 404, 'NOT_FOUND');
    expectError(
      await pin(alice.headers, chatId, '00000000-0000-7000-8000-000000000000'),
      404,
      'NOT_FOUND',
    );
    expectError(await pin(alice.headers, chatId, 'not-a-uuid'), 400, 'VALIDATION_ERROR');

    expectNoContent(
      await app.request.delete(`/api/chats/${chatId}/messages/${ownId}`).set(alice.headers),
    );
    expectError(await pin(alice.headers, chatId, ownId), 404, 'NOT_FOUND');
  });

  it('enforces auth and membership', async () => {
    const { alice, chatId } = await pair();
    const messageId = await send(alice.headers, chatId, 'guarded');
    const unverified = await fixture.unverifiedUser('Unverified');
    const outsider = await fixture.verifiedUser('Charlie');

    expectError(await pin({}, chatId, messageId), 401, 'UNAUTHORIZED');
    expectError(await pin(unverified.headers, chatId, messageId), 403, 'EMAIL_NOT_VERIFIED');
    expectError(
      await app.request.get(`/api/chats/${chatId}/pins`).set(outsider.headers),
      403,
      'NOT_CHAT_MEMBER',
    );
  });

  it('pins in a secret chat without changing ciphertext', async () => {
    const alice = await fixture.verifiedUser('Alice');
    const bob = await fixture.verifiedUser('Bob');
    await fixture.registerDevice(alice);
    const bobDevice = await fixture.registerDevice(bob);
    const chatId = await fixture.openSecretChat(bob.id, alice.headers);
    const ciphertext = 'c2VjcmV0LWNpcGhlcnRleHQ';
    const sent = expectSuccess<{ id: string; ciphertext: string }>(
      await app.request.post(`/api/chats/${chatId}/secret-messages`).set(alice.headers).send({
        recipientDeviceId: bobDevice.deviceId,
        ciphertext,
        nonce: 'AAAAAAAAAAAAAAAA',
        ephemeralPublicKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      }),
      201,
    );

    expectSuccess(await pin(alice.headers, chatId, sent.id), 201);
    const history = expectSuccess<
      Array<{ id: string; ciphertext: string; pinnedAt: string | null }>
    >(await app.request.get(`/api/chats/${chatId}/messages`).set(alice.headers), 200);
    const row = history.find((message) => message.id === sent.id);
    expect(row?.ciphertext).toBe(ciphertext);
    expect(row?.pinnedAt).not.toBeNull();
  });
});
