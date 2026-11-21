import { describe, expect, it, vi } from 'vitest';
import {
  E2eeNotAllowedException,
  NotChatMemberException,
} from '@/core/errors/domain.error.js';
import type { MessagingPolicy } from '@/modules/messages/logic/messaging-policy.service.js';
import type { ChatRepository } from '@/modules/messages/logic/ports/chat.repository.js';
import type { MessageRepository } from '@/modules/messages/logic/ports/message.repository.js';
import { SearchService } from '@/modules/messages/logic/search.service.js';

describe('SearchService', () => {
  const query = { q: 'running', limit: 31, beforeId: 'cursor-id' };

  function makeService(chatType: 'direct' | 'secret' = 'direct') {
    const policy = { requireMember: vi.fn(async () => undefined) };
    const chats = { findById: vi.fn(async () => ({ type: chatType })) };
    const messages = { search: vi.fn(async () => []) };

    return {
      policy,
      messages,
      service: new SearchService(
        policy as unknown as MessagingPolicy,
        chats as unknown as ChatRepository,
        messages as unknown as MessageRepository,
      ),
    };
  }

  it('checks membership then delegates the unchanged query', async () => {
    const { policy, messages, service } = makeService();

    await service.search('user-1', 'chat-1', query);

    expect(policy.requireMember).toHaveBeenCalledWith('chat-1', 'user-1');
    expect(messages.search).toHaveBeenCalledWith('chat-1', query);
  });

  it('rejects a secret chat before querying messages', async () => {
    const { messages, service } = makeService('secret');

    await expect(service.search('user-1', 'chat-1', query)).rejects.toBeInstanceOf(
      E2eeNotAllowedException,
    );
    expect(messages.search).not.toHaveBeenCalled();
  });

  it('does not query messages when the caller is not a member', async () => {
    const { messages } = makeService();
    const policy = { requireMember: vi.fn(async () => {
      throw new NotChatMemberException();
    }) };
    const rejecting = new SearchService(
      policy as unknown as MessagingPolicy,
      { findById: vi.fn() } as unknown as ChatRepository,
      messages as unknown as MessageRepository,
    );

    await expect(rejecting.search('user-1', 'chat-1', query)).rejects.toBeInstanceOf(
      NotChatMemberException,
    );
    expect(messages.search).not.toHaveBeenCalled();
  });
});
