import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuthFixture } from '../../fixtures/auth.fixture.js';
import { MediaFixture, type UploadTicketResponse } from '../../fixtures/media.fixture.js';
import { expectError, expectNoContent, expectSuccess } from '../../helpers/assertions.js';
import { TestApp } from '../../helpers/test-app.js';
import { MessagingApiFixture } from './messaging-api.fixture.js';

describe('media message forward, delete, and pinning', () => {
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

  async function setup() {
    const sender = await messaging.verifiedUser('Sender');
    const recipient = await messaging.verifiedUser('Recipient');
    const third = await messaging.verifiedUser('Third');
    const chatA = await messaging.openDirectChat(recipient.id, sender.headers);
    const chatB = await messaging.openDirectChat(third.id, sender.headers);
    const ticketResponse = await app.request
      .post('/api/media/uploads')
      .set(sender.headers)
      .send({ contentType: 'image/png', sizeBytes: 14 });
    const ticket = expectSuccess<UploadTicketResponse>(ticketResponse, 201);
    media.track(ticket);
    await media.put(ticket, Buffer.from('original-bytes'), 'image/png');
    expectSuccess(
      await app.request.post(`/api/media/${ticket.mediaId}/finalize`).set(sender.headers),
      200,
    );
    const sent = expectSuccess<{ id: string; media: { downloadUrl: string } }>(
      await app.request
        .post(`/api/chats/${chatA}/messages/media`)
        .set(sender.headers)
        .send({ mediaId: ticket.mediaId, kind: 'image' }),
      201,
    );
    return { sender, chatA, chatB, ticket, sent };
  }

  it('keeps the object until the last forward is deleted', async () => {
    const { sender, chatA, chatB, ticket, sent } = await setup();
    const forwarded = expectSuccess<{ id: string; media: { downloadUrl: string } }>(
      await app.request
        .post(`/api/chats/${chatA}/messages/${sent.id}/forward`)
        .set(sender.headers)
        .send({ targetChatId: chatB }),
      201,
    );
    expect(forwarded.media.downloadUrl).toContain(ticket.mediaId);

    expectNoContent(
      await app.request.delete(`/api/chats/${chatA}/messages/${sent.id}`).set(sender.headers),
    );
    expectSuccess(await app.request.get(`/api/media/${ticket.mediaId}`).set(sender.headers), 200);

    expectNoContent(
      await app.request.delete(`/api/chats/${chatB}/messages/${forwarded.id}`).set(sender.headers),
    );
    expectError(await app.request.get(`/api/media/${ticket.mediaId}`).set(sender.headers), 404);
  });

  it('blocks manual media delete while a message references it', async () => {
    const { sender, ticket } = await setup();
    expectError(
      await app.request.delete(`/api/media/${ticket.mediaId}`).set(sender.headers),
      409,
      'MEDIA_IN_USE',
    );
  });

  it('serves originally scanned bytes after an object overwrite', async () => {
    const { ticket, sent } = await setup();
    await media.put(ticket, Buffer.from('replaced-bytes'), 'image/png');

    const response = await fetch(sent.media.downloadUrl);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('original-bytes');
  });

  it('rejects PATCH on a media message', async () => {
    const { sender, chatA, sent } = await setup();
    expectError(
      await app.request
        .patch(`/api/chats/${chatA}/messages/${sent.id}`)
        .set(sender.headers)
        .send({ body: 'new body' }),
      400,
      'VALIDATION_ERROR',
    );
  });
});
