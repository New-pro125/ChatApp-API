import { Readable } from 'node:stream';
import { Container } from 'inversify';
import { describe, expect, it } from 'vitest';
import type { AppConfig } from '@/core/config/app.config.js';
import { CORE_TYPES } from '@/core/container/core.types.js';
import { E2eeNotAllowedException } from '@/core/errors/domain.error.js';
import { BadRequestException, ForbiddenException } from '@/core/errors/http.error.js';
import type { MediaAccess, MediaAsset } from '@/core/media/media-access.port.js';
import { MediaAccessService } from '@/modules/media/logic/media-access.service.js';
import type { MediaObjectRepository } from '@/modules/media/logic/ports/media-object.repository.js';
import type { ObjectStore } from '@/modules/media/logic/ports/object-store.js';
import type { VirusScanner } from '@/modules/media/logic/ports/virus-scanner.js';
import { MediaContainer } from '@/modules/media/media.container.js';
import { MEDIA_TYPES } from '@/modules/media/media.types.js';
import { MessageRecord } from '@/modules/messages/logic/entities/message-record.js';
import { MediaKindPolicy } from '@/modules/messages/logic/media-kind.policy.js';
import { MessageService } from '@/modules/messages/logic/message.service.js';
import type { MessagingPolicy } from '@/modules/messages/logic/messaging-policy.service.js';
import type { ChatRepository } from '@/modules/messages/logic/ports/chat.repository.js';
import type { ChatMemberRepository } from '@/modules/messages/logic/ports/chat-member.repository.js';
import type { MessageRepository } from '@/modules/messages/logic/ports/message.repository.js';
import { MessagesContainer } from '@/modules/messages/messages.container.js';
import { MESSAGES_TYPES } from '@/modules/messages/messages.types.js';

function record(overrides: Partial<MessageRecord> = {}): MessageRecord {
  return new MessageRecord(
    'msg1',
    'chat1',
    'sender1',
    'media',
    null,
    null,
    null,
    null,
    null,
    null,
    new Date(),
    null,
    null,
    null,
    null,
    null,
    overrides.media ?? {
      mediaId: 'media1',
      kind: 'image',
      caption: null,
      durationMs: null,
      width: null,
      height: null,
    },
  );
}

const asset: MediaAsset = {
  id: 'media1',
  contentType: 'image/png',
  sizeBytes: 12,
  sha256: 'hash',
};

function setup(chatType: 'direct' | 'secret' = 'direct') {
  const created: unknown[] = [];
  const deleted: string[] = [];
  const released: string[] = [];
  const lookups: string[] = [];
  const stores: string[] = [];
  const messages = {
    create: (input: unknown) => {
      created.push(input);
      return Promise.resolve(record());
    },
    findById: () => Promise.resolve(record()),
    markDeleted: () => {
      deleted.push('msg1');
      return Promise.resolve(true);
    },
    editBody: () => Promise.resolve(record()),
  };
  const chats = { findById: () => Promise.resolve({ id: 'chat1', type: chatType }) };
  const policy = {
    requireMember: () => Promise.resolve(undefined),
    assertChatUnblocked: () => Promise.resolve(undefined),
  };
  const members = { listByChat: () => Promise.resolve([]) };
  const mediaAccess = {
    requireReadyOwned: (mediaId: string) => {
      lookups.push(mediaId);
      return Promise.resolve(asset);
    },
    storeAndScan: (_userId: string, input: { contentType: string }) => {
      stores.push(input.contentType);
      return Promise.resolve(asset);
    },
    signDownload: () =>
      Promise.resolve({
        url: 'https://signed',
        expiresAt: new Date(),
        contentType: 'image/png',
        sizeBytes: 12,
      }),
    releaseIfUnreferenced: (mediaId: string) => {
      released.push(mediaId);
      return Promise.resolve();
    },
    assertDeletable: () => Promise.resolve(undefined),
  } as MediaAccess;
  const service = new MessageService(
    messages as never,
    policy as never,
    chats as never,
    members as never,
    { removeForMessage: () => Promise.resolve() } as never,
    {} as never,
    {} as never,
    mediaAccess,
    new MediaKindPolicy(),
  );
  return { service, created, deleted, released, lookups, stores };
}

function upload(kind: 'image' | 'gif' | 'document') {
  return {
    kind,
    contentType: 'image/png',
    sizeBytes: 3,
    body: Readable.from([Buffer.from('abc')]),
    assertComplete: () => Promise.resolve(undefined),
  };
}

describe('MessageService media behavior', () => {
  it('attaches a ready owned object to a cloud chat', async () => {
    const { service, created } = setup();
    await service.sendMedia('sender1', 'chat1', {
      mediaId: 'media1',
      kind: 'image',
      caption: 'hello',
    });
    expect(created).toMatchObject([
      {
        chatId: 'chat1',
        senderId: 'sender1',
        type: 'media',
        body: null,
        media: { mediaId: 'media1', kind: 'image', caption: 'hello' },
      },
    ]);
  });

  it('rejects media before media lookup in secret chats', async () => {
    const { service, created, lookups } = setup('secret');
    await expect(
      service.sendMedia('sender1', 'chat1', { mediaId: 'media1', kind: 'image' }),
    ).rejects.toThrow(E2eeNotAllowedException);
    expect(created).toEqual([]);
    expect(lookups).toEqual([]);
  });

  it('rejects a kind that does not match the content type', async () => {
    const { service, created } = setup();
    await expect(
      service.sendMedia('sender1', 'chat1', { mediaId: 'media1', kind: 'gif' }),
    ).rejects.toThrow(BadRequestException);
    expect(created).toEqual([]);
  });

  it('rejects editing a media message', async () => {
    const { service } = setup();
    await expect(service.edit('sender1', 'chat1', 'msg1', 'new body')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('forwards media fields without an ownership check', async () => {
    const { service, created } = setup();
    await service.forward('sender1', 'chat1', 'msg1', 'chat2');
    expect(created).toMatchObject([
      {
        chatId: 'chat2',
        type: 'media',
        media: { mediaId: 'media1', kind: 'image' },
        forwardedFromChatId: 'chat1',
        forwardedFromMessageId: 'msg1',
      },
    ]);
  });

  it('releases media after deleting the last known reference', async () => {
    const { service, deleted, released } = setup();
    await service.remove('sender1', 'chat1', 'msg1');
    expect(deleted).toEqual(['msg1']);
    expect(released).toEqual(['media1']);
  });

  it('still forbids non-sender deletion', async () => {
    const { service, released } = setup();
    await expect(service.remove('other', 'chat1', 'msg1')).rejects.toThrow(ForbiddenException);
    expect(released).toEqual([]);
  });

  it('stores and scans a combined upload before creating the message', async () => {
    const { service, created, stores } = setup();
    const sent = await service.sendMediaFromUpload('sender1', 'chat1', upload('image'));
    expect(stores).toEqual(['image/png']);
    expect(created).toMatchObject([
      {
        chatId: 'chat1',
        senderId: 'sender1',
        type: 'media',
        body: null,
        media: { mediaId: 'media1', kind: 'image' },
      },
    ]);
    expect(sent.media?.mediaId).toBe('media1');
  });

  it('rejects a mismatched upload kind before storing any bytes', async () => {
    const { service, created, stores } = setup();
    await expect(service.sendMediaFromUpload('sender1', 'chat1', upload('gif'))).rejects.toThrow(
      BadRequestException,
    );
    expect(stores).toEqual([]);
    expect(created).toEqual([]);
  });

  it('rejects a combined upload in a secret chat before storing any bytes', async () => {
    const { service, created, stores } = setup('secret');
    await expect(service.sendMediaFromUpload('sender1', 'chat1', upload('image'))).rejects.toThrow(
      E2eeNotAllowedException,
    );
    expect(stores).toEqual([]);
    expect(created).toEqual([]);
  });
});

describe('MessageService MediaAccess port timing', () => {
  it('uses a scanner rebound after container boot through the root port', async () => {
    const root = new Container();
    root.bind(CORE_TYPES.Db).toConstantValue({} as never);
    root.bind(CORE_TYPES.E2eeDeviceReader).toConstantValue({} as never);
    root.bind(CORE_TYPES.E2eeCiphertextValidator).toConstantValue({} as never);
    root.bind(CORE_TYPES.Config).toConstantValue({
      media: { allowedContentTypes: ['image/png'], maxBytes: 100, scanRequired: true },
    } as unknown as AppConfig);

    // Mirrors Application's ordering: messages module, then media module.
    const messages = new MessagesContainer(root);
    const media = new MediaContainer(root);

    const scannerCalls: string[] = [];
    const now = new Date();
    media.rebind<MediaObjectRepository>(MEDIA_TYPES.MediaObjectRepository).toConstantValue({
      create: () =>
        Promise.resolve({
          id: 'media1',
          ownerUserId: 'sender1',
          objectKey: 'key',
          contentType: 'image/png',
          sizeBytes: 3,
        }),
      transitionToReady: () =>
        Promise.resolve({
          id: 'media1',
          ownerUserId: 'sender1',
          objectKey: 'key',
          versionId: null,
          contentType: 'image/png',
          sizeBytes: 3,
          sha256: 'hash',
          status: 'ready',
          createdAt: now,
          updatedAt: now,
          finalizedAt: now,
        }),
    } as unknown as MediaObjectRepository);
    media.rebind<ObjectStore>(MEDIA_TYPES.ObjectStore).toConstantValue({
      putStream: () => Promise.resolve(undefined),
      head: () => Promise.resolve({ contentType: 'image/png', sizeBytes: 3, versionId: null }),
      getStream: () => Promise.resolve(Readable.from([Buffer.from('abc')])),
    } as unknown as ObjectStore);
    media.rebind<VirusScanner>(MEDIA_TYPES.VirusScanner).toConstantValue({
      scan: async (stream: Readable) => {
        scannerCalls.push('fake-scanner');
        for await (const _chunk of stream) {
          /* drain the hashing stream */
        }
        return { verdict: 'clean' };
      },
    });

    const created: unknown[] = [];
    messages.rebind<MessageRepository>(MESSAGES_TYPES.MessageRepository).toConstantValue({
      create: (input: unknown) => {
        created.push(input);
        return Promise.resolve(record());
      },
      hasLiveMediaReferences: () => Promise.resolve(false),
    } as unknown as MessageRepository);
    messages.rebind<MessagingPolicy>(MESSAGES_TYPES.MessagingPolicy).toConstantValue({
      requireMember: () => Promise.resolve(undefined),
      assertChatUnblocked: () => Promise.resolve(undefined),
    } as unknown as MessagingPolicy);
    messages.rebind<ChatRepository>(MESSAGES_TYPES.ChatRepository).toConstantValue({
      findById: () => Promise.resolve({ id: 'chat1', type: 'direct' }),
    } as unknown as ChatRepository);
    messages.rebind<ChatMemberRepository>(MESSAGES_TYPES.ChatMemberRepository).toConstantValue({
      listByChat: () => Promise.resolve([]),
    } as unknown as ChatMemberRepository);

    // Resolved after the fixture rebind, like a controller on the first request.
    const service = messages.get<MessageService>(MESSAGES_TYPES.MessageService);
    expect(root.get<MediaAccess>(CORE_TYPES.MediaAccess)).toBeInstanceOf(MediaAccessService);

    await service.sendMediaFromUpload('sender1', 'chat1', upload('image'));
    expect(scannerCalls).toEqual(['fake-scanner']);
    expect(created).toMatchObject([{ media: { mediaId: 'media1', kind: 'image' } }]);
  });
});
