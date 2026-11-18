import { describe, expect, it } from 'vitest';
import { makeE2eeRegistration } from '../../helpers/e2ee-keys.js';
import { TestApp } from '../../helpers/test-app.js';
import { MessagingApiFixture } from './messaging-api.fixture.js';

const ciphertext = {
  recipientDeviceId: '',
  ciphertext: Buffer.from('ciphertext').toString('base64url'),
  nonce: 'A'.repeat(16),
  ephemeralPublicKey: 'B'.repeat(43),
};

describe('secret chats', () => {
  it('stores ciphertext only and rejects secret mutations', async () => {
    const app = await TestApp.create();

    try {
      await app.clearDatabase();
      const fixture = new MessagingApiFixture(app);
      const alice = await fixture.verifiedUser('Alice Secret');
      const bob = await fixture.verifiedUser('Bob Secret');

      for (const user of [alice, bob]) {
        const response = await app.request
          .post('/api/e2ee/devices')
          .set(user.headers)
          .send(makeE2eeRegistration(2));
        expect(response.status).toBe(201);
      }

      const bobDevices = await app.request.get('/api/e2ee/devices').set(bob.headers);
      const bobDeviceId = bobDevices.body.data[0].deviceId as string;

      const opened = await app.request
        .post('/api/chats/secret')
        .set(alice.headers)
        .send({ participantId: bob.id });
      expect(opened.status).toBe(201);
      expect(opened.body.data.type).toBe('secret');
      const chatId = opened.body.data.id as string;

      const sent = await app.request
        .post(`/api/chats/${chatId}/secret-messages`)
        .set(alice.headers)
        .send({ ...ciphertext, recipientDeviceId: bobDeviceId });
      expect(sent.status).toBe(201);
      expect(sent.body.data.body).toBeNull();
      expect(sent.body.data.type).toBe('secret');
      expect(sent.body.data.ciphertext).toBe(ciphertext.ciphertext);

      const rows = await app.pool.query<{ body: string | null; ciphertext: string | null }>(
        `select body, ciphertext from messages where chat_id = $1`,
        [chatId],
      );
      expect(rows.rows[0]?.body).toBeNull();
      expect(rows.rows[0]?.ciphertext).toBe(ciphertext.ciphertext);

      const messageId = sent.body.data.id as string;
      const edit = await app.request
        .patch(`/api/chats/${chatId}/messages/${messageId}`)
        .set(alice.headers)
        .send({ body: 'plaintext' });
      expect(edit.status).toBe(403);
      expect(edit.body.error.code).toBe('E2EE_NOT_ALLOWED');

      const forward = await app.request
        .post(`/api/chats/${chatId}/messages/${messageId}/forward`)
        .set(alice.headers)
        .send({ targetChatId: chatId });
      expect(forward.status).toBe(403);

      const plainSend = await app.request
        .post(`/api/chats/${chatId}/messages`)
        .set(alice.headers)
        .send({ body: 'plaintext' });
      expect(plainSend.status).toBe(403);
      expect(plainSend.body.error.code).toBe('E2EE_NOT_ALLOWED');

      const replySend = await app.request
        .post(`/api/chats/${chatId}/messages`)
        .set(alice.headers)
        .send({ body: 'plaintext', replyToMessageId: messageId });
      expect(replySend.status).toBe(403);
      expect(replySend.body.error.code).toBe('E2EE_NOT_ALLOWED');

      const wrongDevice = await app.request
        .post(`/api/chats/${chatId}/secret-messages`)
        .set(alice.headers)
        .send({
          ...ciphertext,
          recipientDeviceId: '00000000-0000-7000-8000-0000000000ff',
        });
      expect(wrongDevice.status).toBe(404);
      expect(wrongDevice.body.error.code).toBe('E2EE_DEVICE_NOT_FOUND');
    } finally {
      await app.close();
    }
  });
});
