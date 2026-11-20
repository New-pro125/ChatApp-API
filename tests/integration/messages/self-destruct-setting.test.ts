import { Container } from 'inversify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ChatMemberRepository } from '@/modules/messages/logic/ports/chat-member.repository.js';
import { MessagesContainer } from '@/modules/messages/messages.container.js';
import { MESSAGES_TYPES } from '@/modules/messages/messages.types.js';
import { expectError, expectSuccess } from '../../helpers/assertions.js';
import { TestApp } from '../../helpers/test-app.js';
import { MessagingApiFixture } from './messaging-api.fixture.js';

interface PresetResponse {
  preset: '24h' | '7d' | '90d' | null;
}

interface ChatResponse {
  id: string;
  selfDestructPreset: '24h' | '7d' | '90d' | null;
}

describe('per-chat self-destruct settings', () => {
  let app: TestApp;
  let fixture: MessagingApiFixture;
  let members: ChatMemberRepository;

  beforeAll(async () => {
    app = await TestApp.create();
    fixture = new MessagingApiFixture(app);
    const messages = new MessagesContainer(new Container({ parent: app.container }));
    members = messages.get<ChatMemberRepository>(MESSAGES_TYPES.ChatMemberRepository);
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

  it('changes only the caller setting and exposes it in chat lists', async () => {
    const { alice, bob, chatId } = await pair();

    const set = expectSuccess<PresetResponse>(
      await app.request
        .patch(`/api/chats/${chatId}/self-destruct`)
        .set(alice.headers)
        .send({ preset: '7d' }),
      200,
    );
    expect(set.preset).toBe('7d');
    expect((await members.find(chatId, alice.id))?.selfDestructPreset).toBe('7d');
    expect((await members.find(chatId, bob.id))?.selfDestructPreset).toBeNull();

    const aliceChats = expectSuccess<ChatResponse[]>(
      await app.request.get('/api/chats').set(alice.headers),
      200,
    );
    expect(aliceChats.find((chat) => chat.id === chatId)?.selfDestructPreset).toBe('7d');
    const bobChats = expectSuccess<ChatResponse[]>(
      await app.request.get('/api/chats').set(bob.headers),
      200,
    );
    expect(bobChats.find((chat) => chat.id === chatId)?.selfDestructPreset).toBeNull();

    expect(
      expectSuccess<PresetResponse>(
        await app.request
          .patch(`/api/chats/${chatId}/self-destruct`)
          .set(alice.headers)
          .send({ preset: '90d' }),
        200,
      ).preset,
    ).toBe('90d');
    expect(
      expectSuccess<PresetResponse>(
        await app.request
          .patch(`/api/chats/${chatId}/self-destruct`)
          .set(alice.headers)
          .send({ preset: null }),
        200,
      ).preset,
    ).toBeNull();
  });

  it('rejects invalid, missing, unauthenticated, and non-member updates', async () => {
    const { alice, chatId } = await pair();

    expectError(
      await app.request
        .patch(`/api/chats/${chatId}/self-destruct`)
        .set(alice.headers)
        .send({ preset: '1h' }),
      400,
      'VALIDATION_ERROR',
    );
    expectError(
      await app.request.patch(`/api/chats/${chatId}/self-destruct`).set(alice.headers).send({}),
      400,
      'VALIDATION_ERROR',
    );
    expectError(
      await app.request.patch(`/api/chats/${chatId}/self-destruct`).send({ preset: '24h' }),
      401,
      'UNAUTHORIZED',
    );

    const outsider = await fixture.verifiedUser('Outsider');
    expectError(
      await app.request
        .patch(`/api/chats/${chatId}/self-destruct`)
        .set(outsider.headers)
        .send({ preset: '24h' }),
      403,
      'NOT_CHAT_MEMBER',
    );
  });

  it('blocks unverified callers', async () => {
    const { bob, chatId } = await pair();
    const unverified = await fixture.unverifiedUser('Unverified');
    await fixture.openDirectChat(unverified.id, bob.headers);

    expectError(
      await app.request
        .patch(`/api/chats/${chatId}/self-destruct`)
        .set(unverified.headers)
        .send({ preset: '24h' }),
      403,
      'EMAIL_NOT_VERIFIED',
    );
  });
});
