import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { expectError, expectNoContent, expectSuccess } from '../../helpers/assertions.js';
import { TestApp } from '../../helpers/test-app.js';
import { MessagingApiFixture } from './messaging-api.fixture.js';

interface DraftResponse {
  body: string;
  updatedAt: string;
}

describe('message drafts', () => {
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

  function draftUrl(chatId: string): string {
    return `/api/chats/${chatId}/draft`;
  }

  it('saves, reads, overwrites, and deletes a draft', async () => {
    const { alice, chatId } = await pair();

    expect(
      expectSuccess(await app.request.get(draftUrl(chatId)).set(alice.headers), 200),
    ).toBeNull();

    const first = expectSuccess<DraftResponse>(
      await app.request.put(draftUrl(chatId)).set(alice.headers).send({ body: 'first' }),
      200,
    );
    expect(first.body).toBe('first');
    expect(Number.isNaN(Date.parse(first.updatedAt))).toBe(false);

    const second = expectSuccess<DraftResponse>(
      await app.request.put(draftUrl(chatId)).set(alice.headers).send({ body: 'second' }),
      200,
    );
    expect(second.body).toBe('second');
    expect(Date.parse(second.updatedAt)).toBeGreaterThanOrEqual(Date.parse(first.updatedAt));

    expect(
      expectSuccess<DraftResponse>(await app.request.get(draftUrl(chatId)).set(alice.headers), 200),
    ).toEqual(second);

    expectNoContent(await app.request.delete(draftUrl(chatId)).set(alice.headers));
    expectNoContent(await app.request.delete(draftUrl(chatId)).set(alice.headers));
    expect(
      expectSuccess(await app.request.get(draftUrl(chatId)).set(alice.headers), 200),
    ).toBeNull();
  });

  it('keeps drafts private to their author', async () => {
    const { alice, bob, chatId } = await pair();

    await app.request.put(draftUrl(chatId)).set(alice.headers).send({ body: 'alice only' });
    expect(expectSuccess(await app.request.get(draftUrl(chatId)).set(bob.headers), 200)).toBeNull();

    await app.request.put(draftUrl(chatId)).set(bob.headers).send({ body: 'bob only' });

    expect(
      expectSuccess<DraftResponse>(await app.request.get(draftUrl(chatId)).set(alice.headers), 200)
        .body,
    ).toBe('alice only');
    expect(
      expectSuccess<DraftResponse>(await app.request.get(draftUrl(chatId)).set(bob.headers), 200)
        .body,
    ).toBe('bob only');

    const chats = expectSuccess<Array<{ id: string }>>(
      await app.request.get('/api/chats').set(alice.headers),
      200,
    );
    expect(chats.find((chat) => chat.id === chatId)).not.toHaveProperty('draft');

    const history = expectSuccess<Array<Record<string, unknown>>>(
      await app.request.get(`/api/chats/${chatId}/messages`).set(alice.headers),
      200,
    );
    for (const message of history) {
      expect(message).not.toHaveProperty('draft');
    }
  });

  it('rejects secret chats, non-members, and unknown chats', async () => {
    const { alice, bob, chatId } = await pair();

    await fixture.registerDevice(alice);
    await fixture.registerDevice(bob);
    const secretChatId = await fixture.openSecretChat(bob.id, alice.headers);

    expectError(
      await app.request.put(draftUrl(secretChatId)).set(alice.headers).send({ body: 'secret' }),
      403,
      'E2EE_NOT_ALLOWED',
    );
    expectError(
      await app.request.get(draftUrl(secretChatId)).set(alice.headers),
      403,
      'E2EE_NOT_ALLOWED',
    );
    expectError(
      await app.request.delete(draftUrl(secretChatId)).set(alice.headers),
      403,
      'E2EE_NOT_ALLOWED',
    );

    const outsider = await fixture.verifiedUser('Outsider');
    expectError(
      await app.request.put(draftUrl(chatId)).set(outsider.headers).send({ body: 'nope' }),
      403,
      'NOT_CHAT_MEMBER',
    );

    const unknown = '00000000-0000-7000-8000-000000000000';
    expectError(
      await app.request.get(draftUrl(unknown)).set(alice.headers),
      403,
      'NOT_CHAT_MEMBER',
    );
  });

  it('validates bodies and requires an authenticated, verified caller', async () => {
    const { bob, chatId } = await pair();

    expectError(
      await app.request.put(draftUrl(chatId)).set(bob.headers).send({ body: '' }),
      400,
      'VALIDATION_ERROR',
    );
    expectError(
      await app.request.put(draftUrl(chatId)).set(bob.headers).send({ body: '   ' }),
      400,
      'VALIDATION_ERROR',
    );
    expectError(
      await app.request
        .put(draftUrl(chatId))
        .set(bob.headers)
        .send({ body: 'x'.repeat(4097) }),
      400,
      'VALIDATION_ERROR',
    );
    expectError(
      await app.request.put(draftUrl(chatId)).set(bob.headers).send({}),
      400,
      'VALIDATION_ERROR',
    );
    expectError(await app.request.put(draftUrl(chatId)).send({ body: 'x' }), 401, 'UNAUTHORIZED');

    const unverified = await fixture.unverifiedUser('Unverified');
    await fixture.openDirectChat(unverified.id, bob.headers);
    expectError(
      await app.request.put(draftUrl(chatId)).set(unverified.headers).send({ body: 'x' }),
      403,
      'EMAIL_NOT_VERIFIED',
    );
  });

  it('clears only the sender draft after a text send', async () => {
    const { alice, bob, chatId } = await pair();

    await app.request.put(draftUrl(chatId)).set(alice.headers).send({ body: 'unsent' });
    await app.request.put(draftUrl(chatId)).set(bob.headers).send({ body: 'bob draft' });

    expectSuccess(
      await app.request
        .post(`/api/chats/${chatId}/messages`)
        .set(alice.headers)
        .send({ body: 'sent' }),
      201,
    );

    expect(
      expectSuccess(await app.request.get(draftUrl(chatId)).set(alice.headers), 200),
    ).toBeNull();
    expect(
      expectSuccess<DraftResponse>(await app.request.get(draftUrl(chatId)).set(bob.headers), 200)
        .body,
    ).toBe('bob draft');
  });

  it('clears the target draft after a forward', async () => {
    const { alice, chatId } = await pair();
    const carol = await fixture.verifiedUser('Carol');
    const targetChatId = await fixture.openDirectChat(carol.id, alice.headers);

    const source = expectSuccess<{ id: string }>(
      await app.request
        .post(`/api/chats/${chatId}/messages`)
        .set(alice.headers)
        .send({ body: 'source' }),
      201,
    );
    await app.request.put(draftUrl(chatId)).set(alice.headers).send({ body: 'unsent' });
    await app.request
      .put(draftUrl(targetChatId))
      .set(alice.headers)
      .send({ body: 'forward draft' });

    expectSuccess(
      await app.request
        .post(`/api/chats/${chatId}/messages/${source.id}/forward`)
        .set(alice.headers)
        .send({ targetChatId }),
      201,
    );

    expect(
      expectSuccess(await app.request.get(draftUrl(targetChatId)).set(alice.headers), 200),
    ).toBeNull();
    expect(
      expectSuccess<DraftResponse>(await app.request.get(draftUrl(chatId)).set(alice.headers), 200)
        .body,
    ).toBe('unsent');
  });
});
