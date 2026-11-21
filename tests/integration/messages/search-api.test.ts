import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { expectError, expectSuccess } from '../../helpers/assertions.js';
import { TestApp } from '../../helpers/test-app.js';
import { MessagingApiFixture } from './messaging-api.fixture.js';

describe('chat message search API', () => {
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

  async function send(chatId: string, headers: Record<string, string>, body: string) {
    const response = await app.request
      .post(`/api/chats/${chatId}/messages`)
      .set(headers)
      .send({ body });

    return expectSuccess<{ id: string; body: string }>(response, 201);
  }

  it('returns newest-first matches with a standard cursor envelope', async () => {
    const alice = await fixture.verifiedUser('Alice');
    const bob = await fixture.verifiedUser('Bob');
    const chatId = await fixture.openDirectChat(bob.id, alice.headers);
    const first = await send(chatId, alice.headers, 'first running note');
    await send(chatId, alice.headers, 'unrelated note');
    const second = await send(chatId, alice.headers, 'second running note');

    const pageOne = await app.request
      .get(`/api/chats/${chatId}/messages/search?q=running&limit=1`)
      .set(alice.headers);
    const data = expectSuccess<Array<{ id: string; body: string }>>(pageOne);
    expect(data.map((message) => message.id)).toEqual([second.id]);
    expect(data[0]?.body).toBe('second running note');
    expect(pageOne.body.meta.pagination.nextCursor).toBe(second.id);

    const nextCursor = pageOne.body.meta.pagination.nextCursor as string;
    const pageTwo = await app.request
      .get(`/api/chats/${chatId}/messages/search?q=running&limit=1&cursor=${nextCursor}`)
      .set(alice.headers);
    const dataTwo = expectSuccess<Array<{ id: string; body: string }>>(pageTwo);
    expect(dataTwo.map((message) => message.id)).toEqual([first.id]);
    expect(pageTwo.body.meta.pagination.nextCursor).toBeNull();
  });

  it('returns an empty page for a query with no matches', async () => {
    const alice = await fixture.verifiedUser('Alice');
    const bob = await fixture.verifiedUser('Bob');
    const chatId = await fixture.openDirectChat(bob.id, alice.headers);
    await send(chatId, alice.headers, 'a normal message');

    const response = await app.request
      .get(`/api/chats/${chatId}/messages/search?q=zzzznotfound`)
      .set(alice.headers);
    const data = expectSuccess<unknown[]>(response);

    expect(data).toEqual([]);
    expect(response.body.meta.pagination.nextCursor).toBeNull();
  });

  it('returns an empty page for a punctuation-only query', async () => {
    const alice = await fixture.verifiedUser('Alice');
    const bob = await fixture.verifiedUser('Bob');
    const chatId = await fixture.openDirectChat(bob.id, alice.headers);
    await send(chatId, alice.headers, 'a normal message');

    const response = await app.request
      .get(`/api/chats/${chatId}/messages/search?q=%21%21%21`)
      .set(alice.headers);
    const data = expectSuccess<unknown[]>(response);

    expect(data).toEqual([]);
    expect(response.body.meta.pagination.nextCursor).toBeNull();
  });

  it('rejects invalid query parameters with VALIDATION_ERROR', async () => {
    const alice = await fixture.verifiedUser('Alice');
    const bob = await fixture.verifiedUser('Bob');
    const chatId = await fixture.openDirectChat(bob.id, alice.headers);

    const cases = [
      `/api/chats/${chatId}/messages/search`,
      `/api/chats/${chatId}/messages/search?q=%20%20`,
      `/api/chats/${chatId}/messages/search?q=${'a'.repeat(201)}`,
      `/api/chats/${chatId}/messages/search?q=x&cursor=not-a-uuid`,
      `/api/chats/${chatId}/messages/search?q=x&limit=0`,
      `/api/chats/${chatId}/messages/search?q=x&limit=101`,
    ];

    for (const path of cases) {
      const response = await app.request.get(path).set(alice.headers);
      expectError(response, 400, 'VALIDATION_ERROR');
    }
  });

  it('enforces auth, verification, and membership', async () => {
    const alice = await fixture.verifiedUser('Alice');
    const bob = await fixture.verifiedUser('Bob');
    const outsider = await fixture.verifiedUser('Outsider');
    const unverified = await fixture.unverifiedUser('Unverified');
    const chatId = await fixture.openDirectChat(bob.id, alice.headers);

    const anonymous = await app.request.get(`/api/chats/${chatId}/messages/search?q=running`);
    expectError(anonymous, 401, 'UNAUTHORIZED');

    const unverifiedResponse = await app.request
      .get(`/api/chats/${chatId}/messages/search?q=running`)
      .set(unverified.headers);
    expectError(unverifiedResponse, 403, 'EMAIL_NOT_VERIFIED');

    const outsiderResponse = await app.request
      .get(`/api/chats/${chatId}/messages/search?q=running`)
      .set(outsider.headers);
    expectError(outsiderResponse, 403, 'NOT_CHAT_MEMBER');
  });

  it('rejects search when either side has blocked the other', async () => {
    const alice = await fixture.verifiedUser('Alice');
    const bob = await fixture.verifiedUser('Bob');
    const chatId = await fixture.openDirectChat(bob.id, alice.headers);
    await send(chatId, alice.headers, 'running note');
    await fixture.block(bob.id, alice.id);

    const response = await app.request
      .get(`/api/chats/${chatId}/messages/search?q=running`)
      .set(alice.headers);
    expectError(response, 403, 'USER_BLOCKED');
  });

  it('rejects secret chats with E2EE_NOT_ALLOWED', async () => {
    const alice = await fixture.verifiedUser('Alice');
    const bob = await fixture.verifiedUser('Bob');
    await fixture.registerDevice(alice);
    await fixture.registerDevice(bob);
    const secretChatId = await fixture.openSecretChat(bob.id, alice.headers);

    const response = await app.request
      .get(`/api/chats/${secretChatId}/messages/search?q=anything`)
      .set(alice.headers);
    expectError(response, 403, 'E2EE_NOT_ALLOWED');
  });
});
