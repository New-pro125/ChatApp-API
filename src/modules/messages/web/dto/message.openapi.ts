/// <reference types="zod-openapi" />
import { z } from 'zod';
import {
  apiErrorResponseSchema,
  commonErrorResponses,
  noContentResponse,
  successEnvelope,
} from '@/core/http/openapi/openapi.schemas.js';
import type { OpenApiResponseContract, RouteContract } from '@/core/http/openapi/openapi.types.js';
import { combinedMediaFieldsSchema } from '@/core/media/media-form.schema.js';
import {
  chatParamsSchema,
  editMessageSchema,
  forwardMessageSchema,
  listMessagesQuerySchema,
  markReadSchema,
  messageParamsSchema,
  openDirectChatSchema,
  sendMediaMessageSchema,
  sendMessageSchema,
  sendSecretMessageSchema,
} from '@/modules/messages/web/dto/message.schemas.js';

const bearerSecurity = [{ bearerAuth: [] }] as const;

export const errorResponse = (description: string): OpenApiResponseContract => ({
  description,
  schema: apiErrorResponseSchema,
});

export const participantSummarySchema = z
  .object({
    userId: z.uuid(),
    username: z.string().nullable(),
    displayName: z.string(),
    avatarKey: z.string().nullable(),
  })
  .meta({ id: 'ChatParticipant' });

export const chatSchema = z
  .object({
    id: z.uuid(),
    type: z.enum(['direct', 'secret', 'group', 'channel']),
    title: z.string().nullable(),
    unreadCount: z.number().int().nonnegative(),
    participants: z.array(participantSummarySchema),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'Chat' });

export const readWatermarkSchema = z
  .object({
    chatId: z.uuid(),
    lastReadMessageId: z.uuid().nullable(),
    lastReadAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'ReadWatermark' });

export const messageSchema = z
  .object({
    id: z.uuid(),
    chatId: z.uuid(),
    senderId: z.uuid(),
    type: z.enum(['text', 'system', 'secret', 'media']),
    body: z.string().nullable(),
    replyToMessageId: z.uuid().nullable(),
    forwardedFromChatId: z.uuid().nullable(),
    forwardedFromMessageId: z.uuid().nullable(),
    editedAt: z.iso.datetime().nullable(),
    deletedAt: z.iso.datetime().nullable(),
    createdAt: z.iso.datetime(),
    readAt: z.iso.datetime().nullable(),
    pinnedAt: z.iso.datetime().nullable(),
    ciphertext: z.string().nullable(),
    nonce: z.string().nullable(),
    ephemeralPublicKey: z.string().nullable(),
    senderDeviceId: z.uuid().nullable(),
    recipientDeviceId: z.uuid().nullable(),
    media: z
      .object({
        mediaId: z.uuid(),
        kind: z.enum(['image', 'video', 'document', 'voice_note', 'sticker', 'gif']),
        contentType: z.string(),
        sizeBytes: z.number().int().positive(),
        caption: z.string().nullable(),
        durationMs: z.number().int().nullable(),
        width: z.number().int().nullable(),
        height: z.number().int().nullable(),
        downloadUrl: z.url(),
        expiresAt: z.iso.datetime(),
      })
      .nullable(),
  })
  .meta({ id: 'Message' });

const chatResponse = successEnvelope(chatSchema, 'ChatResponse');
const chatListResponse = successEnvelope(z.array(chatSchema), 'ChatListResponse');
const readWatermarkResponse = successEnvelope(readWatermarkSchema, 'ReadWatermarkResponse');
const messageResponse = successEnvelope(messageSchema, 'MessageResponse');
const messageListResponse = successEnvelope(z.array(messageSchema), 'MessageListResponse');

export const pinSchema = z
  .object({
    messageId: z.uuid(),
    pinnedAt: z.iso.datetime(),
  })
  .meta({ id: 'MessagePin' });

const pinResponse = successEnvelope(pinSchema, 'MessagePinResponse');

/**
 * OpenAPI contracts for one-on-one messaging.
 *
 * Request schemas are the same Zod schemas the controllers parse, so the
 * generated document and runtime validation cannot drift.
 */
export const messageContracts = {
  openDirect: {
    operationId: 'chats.openDirect',
    tags: ['Chats'],
    summary: 'Open or retrieve a direct chat',
    description:
      'Creates a direct chat for two distinct users, or returns the existing one when the pair already has a chat. Either participant may open it. Returns 403 USER_BLOCKED when either side has blocked the other.',
    security: bearerSecurity,
    request: { body: openDirectChatSchema },
    responses: {
      200: { description: 'The existing direct chat', schema: chatResponse },
      201: { description: 'The new direct chat', schema: chatResponse },
      ...commonErrorResponses,
    },
  },
  openSecret: {
    operationId: 'chats.openSecret',
    tags: ['Chats'],
    summary: 'Open or retrieve a one-to-one secret chat',
    description:
      'Requires registered E2EE devices for both users. Secret chat content is opaque ciphertext and is never searchable.',
    security: bearerSecurity,
    request: { body: openDirectChatSchema },
    responses: {
      200: { description: 'The existing secret chat', schema: chatResponse },
      201: { description: 'The new secret chat', schema: chatResponse },
      ...commonErrorResponses,
    },
  },
  listChats: {
    operationId: 'chats.listMine',
    tags: ['Chats'],
    summary: 'List the caller chats',
    description:
      'Returns chats the caller belongs to, most recently active first, with public summaries for every participant.',
    security: bearerSecurity,
    responses: {
      200: { description: 'The caller chats', schema: chatListResponse },
      ...commonErrorResponses,
    },
  },
  sendMessage: {
    operationId: 'chats.sendMessage',
    tags: ['Messages'],
    summary: 'Send a text message',
    description:
      'Sends a text message to a chat the caller belongs to. Replies must target a message in the same chat. Sending bumps the chat activity time.',
    security: bearerSecurity,
    request: { params: chatParamsSchema, body: sendMessageSchema },
    responses: {
      201: { description: 'The sent message', schema: messageResponse },
      ...commonErrorResponses,
    },
  },
  sendMedia: {
    operationId: 'messages.sendMedia',
    tags: ['Messages'],
    summary: 'Attach a ready media object to a cloud chat message',
    security: bearerSecurity,
    request: {
      params: chatParamsSchema,
      body: sendMediaMessageSchema,
    },
    responses: {
      201: { description: 'The attached media message', schema: messageResponse },
      ...commonErrorResponses,
      409: errorResponse('Media object is not ready'),
    },
  },
  uploadMedia: {
    operationId: 'messages.uploadMedia',
    tags: ['Messages'],
    summary: 'Upload a file and send it as a cloud media message',
    security: bearerSecurity,
    request: {
      params: chatParamsSchema,
      body: combinedMediaFieldsSchema.extend({
        file: z.string().meta({ format: 'binary' }),
      }),
      contentType: 'multipart/form-data',
    },
    responses: {
      201: { description: 'The uploaded media message', schema: messageResponse },
      ...commonErrorResponses,
      409: errorResponse('Media object is not ready'),
      422: errorResponse('The uploaded file is infected'),
      503: errorResponse('Virus scanning is temporarily unavailable'),
    },
  },
  sendSecretMessage: {
    operationId: 'chats.sendSecretMessage',
    tags: ['Messages'],
    summary: 'Store ciphertext in a secret chat',
    description:
      'Stores AES-GCM ciphertext for a device owned by the other participant. The server cannot decrypt it.',
    security: bearerSecurity,
    request: { params: chatParamsSchema, body: sendSecretMessageSchema },
    responses: {
      201: { description: 'The stored ciphertext message', schema: messageResponse },
      ...commonErrorResponses,
    },
  },
  listMessages: {
    operationId: 'chats.listMessages',
    tags: ['Messages'],
    summary: 'List message history with keyset pagination',
    description:
      'Returns messages newest first. Pass the `meta.pagination.nextCursor` from the previous page as `cursor` to continue; the cursor is the last message id and the response stops when it is null.',
    security: bearerSecurity,
    request: { params: chatParamsSchema, query: listMessagesQuerySchema },
    responses: {
      200: { description: 'A page of messages', schema: messageListResponse },
      ...commonErrorResponses,
    },
  },
  editMessage: {
    operationId: 'chats.editMessage',
    tags: ['Messages'],
    summary: 'Edit an owned message',
    description: 'Only the original sender may edit a message, and tombstones cannot be edited.',
    security: bearerSecurity,
    request: { params: messageParamsSchema, body: editMessageSchema },
    responses: {
      200: { description: 'The edited message', schema: messageResponse },
      ...commonErrorResponses,
    },
  },
  deleteMessage: {
    operationId: 'chats.deleteMessage',
    tags: ['Messages'],
    summary: 'Soft-delete an owned message',
    description:
      'Only the original sender may delete a message. The row remains as a tombstone with a null body so reply threads stay intact.',
    security: bearerSecurity,
    request: { params: messageParamsSchema },
    responses: {
      204: noContentResponse,
      ...commonErrorResponses,
    },
  },
  forwardMessage: {
    operationId: 'chats.forwardMessage',
    tags: ['Messages'],
    summary: 'Forward a message to another chat',
    description:
      'Copies a message body into a target chat the caller belongs to and records the source chat and message id on the copy.',
    security: bearerSecurity,
    request: { params: messageParamsSchema, body: forwardMessageSchema },
    responses: {
      201: { description: 'The forwarded copy', schema: messageResponse },
      ...commonErrorResponses,
    },
  },
  pinMessage: {
    operationId: 'messages.pinMessage',
    tags: ['Messages'],
    summary: 'Pin a message for the caller',
    description:
      'Adds a private bookmark to a live message in a direct or secret chat. Each user has at most ten pins per chat; an eleventh returns 409 CONFLICT. Pinning again keeps the original timestamp.',
    security: bearerSecurity,
    request: { params: messageParamsSchema },
    responses: {
      201: { description: 'The created pin', schema: pinResponse },
      ...commonErrorResponses,
      409: errorResponse('Pin limit reached'),
    },
  },
  unpinMessage: {
    operationId: 'messages.unpinMessage',
    tags: ['Messages'],
    summary: 'Remove the caller pin from a message',
    description: 'Idempotent: removing a pin that does not exist still returns 204.',
    security: bearerSecurity,
    request: { params: messageParamsSchema },
    responses: {
      204: noContentResponse,
      ...commonErrorResponses,
    },
  },
  listPinned: {
    operationId: 'messages.listPinned',
    tags: ['Messages'],
    summary: 'List the caller pinned messages in a chat',
    description:
      'Returns the caller private bookmarks, newest pin first, as full message views with pinnedAt. Pins belonging to the other participant are never returned.',
    security: bearerSecurity,
    request: { params: chatParamsSchema },
    responses: {
      200: { description: 'The caller pinned messages', schema: messageListResponse },
      ...commonErrorResponses,
    },
  },
  markRead: {
    operationId: 'chats.markRead',
    tags: ['Chats'],
    summary: 'Advance the caller read watermark for a chat',
    description:
      'Marks a chat read up to the supplied message id, or to the newest message when omitted. The watermark never moves backwards. Marking is explicit; listing history does not change read state. Works for direct and secret chats; secret chat ciphertext is never read or modified.',
    security: bearerSecurity,
    request: { params: chatParamsSchema, body: markReadSchema },
    responses: {
      200: { description: 'The updated read watermark', schema: readWatermarkResponse },
      ...commonErrorResponses,
    },
  },
} satisfies Record<string, RouteContract>;
