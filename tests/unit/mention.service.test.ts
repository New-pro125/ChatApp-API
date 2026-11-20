import { describe, expect, it, vi } from 'vitest';
import { NotFoundException } from '@/core/errors/http.error.js';
import { MessageMentionRecord } from '@/modules/messages/logic/entities/message-mention-record.js';
import { MentionService } from '@/modules/messages/logic/mention.service.js';

const now = new Date('2026-11-20T12:00:00Z');

function setup() {
  const repository = {
    sync: vi.fn(async () => undefined),
    hideForMessage: vi.fn(async () => undefined),
    listForMessages: vi.fn(async () => new Map<string, MessageMentionRecord[]>()),
    list: vi.fn(async () => [] as MessageMentionRecord[]),
    countUnread: vi.fn(async () => 0),
    findById: vi.fn(async () => null as MessageMentionRecord | null),
    markRead: vi.fn(async (_userId: string, _ids: readonly string[], _now: Date) => 1),
  };
  const usernames = {
    findByUsername: vi.fn((name: string) => {
      const ids: Record<string, string> = {
        alice: 'user-alice',
        bobby: 'user-bob',
        outsider: 'user-outsider',
      };
      return Promise.resolve(ids[name.toLowerCase()] ?? null);
    }),
  };
  const members = {
    listByChat: vi.fn(async () => [
      { userId: 'user-alice', leftAt: null },
      { userId: 'user-bob', leftAt: null },
    ]),
  };
  const service = new MentionService(repository as never, usernames as never, members as never);

  return { service, repository, usernames, members };
}

function record(id: string): MessageMentionRecord {
  return new MessageMentionRecord(id, 'chat1', 'msg1', 'user-alice', 'user-bob', now, now, null);
}

describe('MentionService', () => {
  it('resolves only resolved names that belong to the chat', async () => {
    const { service, repository } = setup();

    await service.sync('chat1', 'msg1', '@ALICE @bobby @outsider @nobody mail a@example.com');

    expect(repository.sync).toHaveBeenCalledWith(
      'chat1',
      'msg1',
      ['user-alice', 'user-bob'],
      expect.any(Date),
    );
  });

  it('still syncs an empty target set when all mentions were removed', async () => {
    const { service, repository } = setup();

    await service.sync('chat1', 'msg1', 'no mentions here');

    expect(repository.sync).toHaveBeenCalledWith('chat1', 'msg1', [], expect.any(Date));
  });

  it('hides through the repository', async () => {
    const { service, repository } = setup();

    await service.hideForMessage('chat1', 'msg1');

    expect(repository.hideForMessage).toHaveBeenCalledWith('chat1', 'msg1', expect.any(Date));
  });

  it('throws not found for another user mention and caps bulk mark-read', async () => {
    const { service, repository } = setup();

    await expect(service.markOne('user-alice', 'missing')).rejects.toThrow(NotFoundException);

    repository.findById.mockImplementation(async () => record('mention1'));
    const result = await service.markOne('user-bob', 'mention1');
    expect(result.id).toBe('mention1');

    const ids = Array.from({ length: 120 }, (_, index) => `m${index}`);
    expect(await service.markMany('user-bob', ids)).toBe(1);
    expect(repository.markRead.mock.calls.at(-1)?.[1]).toHaveLength(100);
    expect(new Set(repository.markRead.mock.calls.at(-1)?.[1]).size).toBe(100);
  });
});
