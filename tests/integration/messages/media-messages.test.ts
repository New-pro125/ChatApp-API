import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuthFixture } from '../../fixtures/auth.fixture.js';
import { MediaFixture } from '../../fixtures/media.fixture.js';
import { expectError, expectSuccess } from '../../helpers/assertions.js';
import { TestApp } from '../../helpers/test-app.js';
import { MessagingApiFixture } from './messaging-api.fixture.js';

describe('media message attach mode', () => {
  let app: TestApp;
  let auth: AuthFixture;
  let messaging: MessagingApiFixture;
  let media: MediaFixture;

  beforeAll(async () => {
    app = await TestApp.create();
    auth = new AuthFixture(app);
    messaging = new MessagingApiFixture(app);
    media = new MediaFixture(app);
  });

  afterAll(async () => {
    await media.cleanup();
    await app.close();
  });

  beforeEach(async () => {
    await app.clearDatabase();
    auth.emails.clear();
    media.scanner.mode = 'clean';
  });

  async function readyPng(headers: Record<string, string>) {
    const ticketResponse = await app.request
      .post('/api/media/uploads')
      .set(headers)
      .send({ contentType: 'image/png', sizeBytes: 11 });
    const ticket = expectSuccess<{
      mediaId: string;
      objectKey: string;
      uploadUrl: string;
      headers: { 'Content-Type': string; 'Content-Length': string };
      expiresAt: string;
    }>(ticketResponse, 201);
    media.track(ticket);
    await media.put(ticket, Buffer.from('clean-bytes'), 'image/png');
    const finalized = await app.request.post(`/api/media/${ticket.mediaId}/finalize`).set(headers);
    expectSuccess(finalized, 200);
    return ticket.mediaId;
  }

  it('attaches a ready object and returns a signed URL to a non-owner member', async () => {
    const sender = await messaging.verifiedUser('Sender');
    const recipient = await messaging.verifiedUser('Recipient');
    const chatId = await messaging.openDirectChat(recipient.id, sender.headers);
    const mediaId = await readyPng(sender.headers);

    const sent = await app.request
      .post(`/api/chats/${chatId}/messages/media`)
      .set(sender.headers)
      .send({ mediaId, kind: 'image', caption: 'look' });
    const message = expectSuccess<{
      id: string;
      type: string;
      body: string | null;
      media: {
        mediaId: string;
        kind: string;
        contentType: string;
        sizeBytes: number;
        caption: string | null;
        downloadUrl: string;
      };
    }>(sent, 201);

    expect(message.type).toBe('media');
    expect(message.body).toBeNull();
    expect(message.media.mediaId).toBe(mediaId);
    expect(JSON.stringify(message)).not.toContain('objectKey');
    expect(JSON.stringify(message)).not.toContain('sha256');

    const listed = await app.request.get(`/api/chats/${chatId}/messages`).set(recipient.headers);
    const page = expectSuccess<Array<{ media: { downloadUrl: string } }>>(listed, 200);
    expect(page).toHaveLength(1);
    const first = page[0];
    if (!first) {
      throw new Error('Expected one media message');
    }
    const response = await fetch(first.media.downloadUrl);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('clean-bytes');
  });

  it('rejects media in a secret chat before creating a message', async () => {
    const sender = await messaging.verifiedUser('Sender');
    const recipient = await messaging.verifiedUser('Recipient');
    await messaging.registerDevice(recipient);
    await messaging.registerDevice(sender);
    const chatId = await messaging.openSecretChat(recipient.id, sender.headers);
    const mediaId = await readyPng(sender.headers);

    const response = await app.request
      .post(`/api/chats/${chatId}/messages/media`)
      .set(sender.headers)
      .send({ mediaId, kind: 'image' });
    expectError(response, 403, 'E2EE_NOT_ALLOWED');

    const listed = await app.request.get(`/api/chats/${chatId}/messages`).set(sender.headers);
    expect(expectSuccess<unknown[]>(listed, 200)).toEqual([]);
  });

  it('rejects a non-member, an unverified user, and a kind mismatch', async () => {
    const sender = await messaging.verifiedUser('Sender');
    const outsider = await messaging.verifiedUser('Outsider');
    const recipient = await messaging.verifiedUser('Recipient');
    const chatId = await messaging.openDirectChat(recipient.id, sender.headers);
    const mediaId = await readyPng(sender.headers);

    expectError(
      await app.request
        .post(`/api/chats/${chatId}/messages/media`)
        .set(outsider.headers)
        .send({ mediaId, kind: 'image' }),
      403,
      'NOT_CHAT_MEMBER',
    );

    const unverified = await messaging.unverifiedUser('Unverified');
    expectError(
      await app.request
        .post(`/api/chats/${chatId}/messages/media`)
        .set(unverified.headers)
        .send({ mediaId, kind: 'image' }),
      403,
      'EMAIL_NOT_VERIFIED',
    );

    expectError(
      await app.request
        .post(`/api/chats/${chatId}/messages/media`)
        .set(sender.headers)
        .send({ mediaId, kind: 'gif' }),
      400,
      'VALIDATION_ERROR',
    );
  });

  it('rejects a non-ready media id', async () => {
    const sender = await messaging.verifiedUser('Sender');
    const recipient = await messaging.verifiedUser('Recipient');
    const chatId = await messaging.openDirectChat(recipient.id, sender.headers);

    const ticketResponse = await app.request
      .post('/api/media/uploads')
      .set(sender.headers)
      .send({ contentType: 'image/png', sizeBytes: 9 });
    const ticket = expectSuccess<{ mediaId: string; objectKey: string }>(ticketResponse, 201);
    media.track(ticket as never);

    expectError(
      await app.request
        .post(`/api/chats/${chatId}/messages/media`)
        .set(sender.headers)
        .send({ mediaId: ticket.mediaId, kind: 'image' }),
      409,
      'MEDIA_NOT_READY',
    );
  });
});
