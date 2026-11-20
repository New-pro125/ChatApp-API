import { Container } from 'inversify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { MessageRepository } from '@/modules/messages/logic/ports/message.repository.js';
import { MessagesContainer } from '@/modules/messages/messages.container.js';
import { MESSAGES_TYPES } from '@/modules/messages/messages.types.js';
import { expectError, expectSuccess } from '../../helpers/assertions.js';
import { TestApp } from '../../helpers/test-app.js';
import { MessagingApiFixture } from './messaging-api.fixture.js';

interface MessageView {
  id: string;
  body: string | null;
  ciphertext: string | null;
  [key: string]: unknown;
}

describe('self-destructing message behavior', () => {
  let app: TestApp;
  let fixture: MessagingApiFixture;
  let messages: MessageRepository;

  beforeAll(async () => {
    app = await TestApp.create();
    fixture = new MessagingApiFixture(app);
    const container = new MessagesContainer(new Container({ parent: app.container }));
    messages = container.get<MessageRepository>(MESSAGES_TYPES.MessageRepository);
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

  function setPreset(headers: Record<string, string>, chatId: string, preset: string | null) {
    return app.request.patch(`/api/chats/${chatId}/self-destruct`).set(headers).send({ preset });
  }

  function send(headers: Record<string, string>, chatId: string, body: string) {
    return app.request.post(`/api/chats/${chatId}/messages`).set(headers).send({ body });
  }

  function age(chatId: string, messageId: string) {
    return app.pool.query(
      `UPDATE messages SET created_at = now() - interval '2 seconds',
       expires_at = now() - interval '1 second'
       WHERE chat_id = $1 AND id = $2`,
      [chatId, messageId],
    );
  }

  it('applies only the sender current preset and does not expose expiry on messages', async () => {
    const { alice, bob, chatId } = await pair();
    expectSuccess(await setPreset(alice.headers, chatId, '24h'), 200);

    const first = expectSuccess<MessageView>(await send(alice.headers, chatId, 'first'), 201);
    expect(first).not.toHaveProperty('expiresAt');
    expect(first).not.toHaveProperty('selfDestruct');
    const firstRow = await messages.findById(chatId, first.id);
    expect(firstRow?.expiresAt).not.toBeNull();

    const bobMessage = expectSuccess<MessageView>(await send(bob.headers, chatId, 'bob'), 201);
    expect((await messages.findById(chatId, bobMessage.id))?.expiresAt).toBeNull();

    expectSuccess(await setPreset(alice.headers, chatId, '7d'), 200);
    const second = expectSuccess<MessageView>(await send(alice.headers, chatId, 'second'), 201);
    const firstDeadline = firstRow?.expiresAt?.getTime() ?? 0;
    const secondDeadline = (await messages.findById(chatId, second.id))?.expiresAt?.getTime() ?? 0;
    expect(secondDeadline - firstDeadline).toBeGreaterThan(0);

    expectSuccess(await setPreset(alice.headers, chatId, null), 200);
    const third = expectSuccess<MessageView>(await send(alice.headers, chatId, 'third'), 201);
    expect((await messages.findById(chatId, third.id))?.expiresAt).toBeNull();
  });

  it('hides elapsed messages and returns 404 for expired targets', async () => {
    const { alice, chatId } = await pair();
    expectSuccess(await setPreset(alice.headers, chatId, '24h'), 200);
    const created = expectSuccess<MessageView>(await send(alice.headers, chatId, 'gone'), 201);
    await age(chatId, created.id);

    const history = expectSuccess<MessageView[]>(
      await app.request.get(`/api/chats/${chatId}/messages`).set(alice.headers),
      200,
    );
    expect(history.map((message) => message.id)).not.toContain(created.id);

    expectError(
      await app.request
        .patch(`/api/chats/${chatId}/messages/${created.id}`)
        .set(alice.headers)
        .send({ body: 'edit' }),
      404,
      'NOT_FOUND',
    );
    expectError(
      await app.request.delete(`/api/chats/${chatId}/messages/${created.id}`).set(alice.headers),
      404,
      'NOT_FOUND',
    );
    expectError(
      await app.request
        .post(`/api/chats/${chatId}/messages/${created.id}/pin`)
        .set(alice.headers)
        .send({ durationSeconds: 3600 }),
      404,
      'NOT_FOUND',
    );
    expectError(
      await app.request
        .post(`/api/chats/${chatId}/read`)
        .set(alice.headers)
        .send({ messageId: created.id }),
      404,
      'NOT_FOUND',
    );
  });

  it('applies the target-chat preset to forwarded messages', async () => {
    const { alice, bob, chatId } = await pair();
    const third = await fixture.verifiedUser('Third');
    const targetChatId = await fixture.openDirectChat(third.id, alice.headers);
    const source = expectSuccess<MessageView>(await send(bob.headers, chatId, 'source'), 201);

    expectSuccess(await setPreset(alice.headers, targetChatId, '7d'), 200);
    const forwarded = expectSuccess<MessageView>(
      await app.request
        .post(`/api/chats/${chatId}/messages/${source.id}/forward`)
        .set(alice.headers)
        .send({ targetChatId }),
      201,
    );
    expect((await messages.findById(targetChatId, forwarded.id))?.expiresAt).not.toBeNull();
  });

  it('sets a hidden expiry on secret ciphertext without exposing plaintext', async () => {
    const alice = await fixture.verifiedUser('Alice');
    const bob = await fixture.verifiedUser('Bob');
    await fixture.registerDevice(alice);
    const bobDevice = await fixture.registerDevice(bob, 3);
    const chatId = await fixture.openSecretChat(bob.id, alice.headers);
    expectSuccess(await setPreset(alice.headers, chatId, '24h'), 200);

    const sent = expectSuccess<MessageView>(
      await app.request.post(`/api/chats/${chatId}/secret-messages`).set(alice.headers).send({
        recipientDeviceId: bobDevice.deviceId,
        ciphertext: 'QUJD',
        nonce: 'AAAAAAAAAAAAAAAA',
        ephemeralPublicKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      }),
      201,
    );
    expect(sent.body).toBeNull();
    expect(sent.ciphertext).toBe('QUJD');
    expect(sent).not.toHaveProperty('expiresAt');
    expect((await messages.findById(chatId, sent.id))?.expiresAt).not.toBeNull();
  });
});
