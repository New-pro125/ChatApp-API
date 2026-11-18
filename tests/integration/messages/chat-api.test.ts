import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { TestApp } from '../../helpers/test-app.js';
import { MessagingApiFixture } from './messaging-api.fixture.js';

describe('Chat API', () => {
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

  it('opens a direct chat idempotently with participant summaries', async () => {
    const alice = await fixture.verifiedUser('Alice');
    const bob = await fixture.verifiedUser('Bob');

    const created = await app.request
      .post('/api/chats')
      .set(alice.headers)
      .send({ participantId: bob.id });

    expect(created.status).toBe(201);
    expect(created.body.data.type).toBe('direct');
    expect(created.body.data.title).toBeNull();
    expect(created.body.data.participants).toHaveLength(2);
    expect(created.body.data.participants.map((p: { userId: string }) => p.userId).sort()).toEqual(
      [alice.id, bob.id].sort(),
    );
    expect(
      created.body.data.participants.map((p: { displayName: string }) => p.displayName).sort(),
    ).toEqual(['Alice', 'Bob']);

    const again = await app.request
      .post('/api/chats')
      .set(bob.headers)
      .send({ participantId: alice.id });

    expect(again.status).toBe(200);
    expect(again.body.data.id).toBe(created.body.data.id);
  });

  it('rejects opening a chat with yourself', async () => {
    const alice = await fixture.verifiedUser('Alice');

    const response = await app.request
      .post('/api/chats')
      .set(alice.headers)
      .send({ participantId: alice.id });

    expect(response.status).toBe(400);
  });

  it('rejects an unknown participant', async () => {
    const alice = await fixture.verifiedUser('Alice');

    const response = await app.request
      .post('/api/chats')
      .set(alice.headers)
      .send({ participantId: randomUUID() });

    expect(response.status).toBe(404);
  });

  it('rejects an unverified caller', async () => {
    const alice = await fixture.unverifiedUser('Alice');
    const bob = await fixture.verifiedUser('Bob');

    const response = await app.request
      .post('/api/chats')
      .set(alice.headers)
      .send({ participantId: bob.id });

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('EMAIL_NOT_VERIFIED');
  });

  it('rejects an unverified caller listing chats', async () => {
    const alice = await fixture.unverifiedUser('Alice');

    const response = await app.request.get('/api/chats').set(alice.headers);

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('EMAIL_NOT_VERIFIED');
  });

  it('rejects a direct chat when either side has blocked the other', async () => {
    const alice = await fixture.verifiedUser('Alice');
    const bob = await fixture.verifiedUser('Bob');
    await fixture.block(bob.id, alice.id);

    const fromAlice = await app.request
      .post('/api/chats')
      .set(alice.headers)
      .send({ participantId: bob.id });
    const fromBob = await app.request
      .post('/api/chats')
      .set(bob.headers)
      .send({ participantId: alice.id });

    expect(fromAlice.status).toBe(403);
    expect(fromAlice.body.error.code).toBe('USER_BLOCKED');
    expect(fromBob.status).toBe(403);
    expect(fromBob.body.error.code).toBe('USER_BLOCKED');
  });

  it('lists only the chats the caller belongs to', async () => {
    const alice = await fixture.verifiedUser('Alice');
    const bob = await fixture.verifiedUser('Bob');
    const charlie = await fixture.verifiedUser('Charlie');
    const sharedChat = await fixture.openDirectChat(bob.id, alice.headers);
    await fixture.openDirectChat(charlie.id, bob.headers);

    const response = await app.request.get('/api/chats').set(alice.headers);

    expect(response.status).toBe(200);
    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0].id).toBe(sharedChat);
    expect(response.body.data[0].participants).toHaveLength(2);
  });

  it('requires authentication', async () => {
    const response = await app.request.get('/api/chats');

    expect(response.status).toBe(401);
  });
});
