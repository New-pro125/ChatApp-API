import { Container } from 'inversify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ChatMemberRepository } from '@/modules/messages/logic/ports/chat-member.repository.js';
import { MessagesContainer } from '@/modules/messages/messages.container.js';
import { MESSAGES_TYPES } from '@/modules/messages/messages.types.js';
import { TestApp } from '../../helpers/test-app.js';
import { MessagingApiFixture } from './messaging-api.fixture.js';

describe('chat member mute persistence', () => {
  let app: TestApp;
  let fixture: MessagingApiFixture;
  let members: ChatMemberRepository;

  beforeAll(async () => {
    app = await TestApp.create();
    fixture = new MessagingApiFixture(app);
    const container = new MessagesContainer(new Container({ parent: app.container }));
    members = container.get<ChatMemberRepository>(MESSAGES_TYPES.ChatMemberRepository);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await app.clearDatabase();
  });

  it('stores, isolates, and clears one caller mute', async () => {
    const alice = await fixture.verifiedUser('Alice');
    const bob = await fixture.verifiedUser('Bob');
    const chatId = await fixture.openDirectChat(bob.id, alice.headers);
    const mutedAt = new Date('2026-11-20T10:00:00.000Z');
    const mutedUntil = new Date('2026-11-21T10:00:00.000Z');

    const updated = await members.setMute(chatId, alice.id, mutedAt, mutedUntil);
    expect(updated.mutedAt).toEqual(mutedAt);
    expect(updated.mutedUntil).toEqual(mutedUntil);
    expect((await members.find(chatId, bob.id))?.mutedAt).toBeNull();

    const cleared = await members.setMute(chatId, alice.id, null, null);
    expect(cleared.mutedAt).toBeNull();
    expect(cleared.mutedUntil).toBeNull();
  });
});
