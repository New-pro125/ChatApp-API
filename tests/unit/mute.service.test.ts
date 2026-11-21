import { describe, expect, it, vi } from 'vitest';
import { ChatMemberRecord } from '@/modules/messages/logic/entities/chat-member-record.js';
import type { MessagingPolicy } from '@/modules/messages/logic/messaging-policy.service.js';
import { MuteService } from '@/modules/messages/logic/mute.service.js';
import type { ChatMemberRepository } from '@/modules/messages/logic/ports/chat-member.repository.js';

describe('MuteService', () => {
  const now = new Date('2026-11-20T10:00:00.000Z');
  const expiresAt = new Date('2026-11-20T18:00:00.000Z');
  const chatId = 'chat-1';
  const userId = 'user-1';

  function makeService() {
    const policy = { requireMember: vi.fn(async () => undefined) };
    const members = {
      setMute: vi.fn(
        async () =>
          new ChatMemberRecord(
            chatId,
            userId,
            'member',
            now,
            null,
            null,
            null,
            null,
            now,
            expiresAt,
          ),
      ),
    };

    return {
      policy,
      members,
      service: new MuteService(
        policy as unknown as MessagingPolicy,
        members as unknown as ChatMemberRepository,
      ),
    };
  }

  it('maps a timed preset through the repository', async () => {
    const { policy, members, service } = makeService();

    const result = await service.setMute(userId, chatId, '8h', now);

    expect(policy.requireMember).toHaveBeenCalledWith(chatId, userId);
    expect(members.setMute).toHaveBeenCalledWith(chatId, userId, now, expiresAt);
    expect(result).toEqual({ chatId, muted: true, muteExpiresAt: expiresAt });
  });

  it('clears both columns for null', async () => {
    const { members, service } = makeService();

    await service.setMute(userId, chatId, null, now);

    expect(members.setMute).toHaveBeenCalledWith(chatId, userId, null, null);
  });
});
