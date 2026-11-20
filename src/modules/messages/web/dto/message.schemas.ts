import { z } from 'zod';
import { mediaKindSchema } from '@/core/media/media-form.schema.js';
import { SELF_DESTRUCT_PRESETS } from '@/modules/messages/logic/entities/self-destruct-preset.js';

export type { CombinedMediaFieldsSchema, MediaKind } from '@/core/media/media-form.schema.js';
export { combinedMediaFieldsSchema, mediaKindSchema } from '@/core/media/media-form.schema.js';

/** A text body. The database check constraint allows 1–4096 characters. */
export const messageBodySchema = z.string().min(1).max(4096);

/** Body for an unsent draft. Trimming rejects whitespace-only drafts. */
export const saveDraftSchema = z.object({
  body: z.string().trim().min(1).max(4096),
});

export type SaveDraftSchema = z.infer<typeof saveDraftSchema>;

/** Body for opening (or retrieving) a direct chat with another user. */
export const openDirectChatSchema = z.object({
  participantId: z.uuid(),
});

/** Route parameters for chat-scoped operations. */
export const chatParamsSchema = z.object({
  chatId: z.uuid(),
});

/** Body for advancing a chat's read watermark. An absent id means "up to now". */
export const markReadSchema = z.object({
  messageId: z.uuid().optional(),
});

/** Caller-scoped self-destruct preset; null clears the caller's timer. */
export const selfDestructPresetSchema = z.enum(SELF_DESTRUCT_PRESETS);

export const setSelfDestructSchema = z.object({
  preset: selfDestructPresetSchema.nullable(),
});

/** Route parameters for operations on a single message. */
export const messageParamsSchema = z.object({
  chatId: z.uuid(),
  messageId: z.uuid(),
});

/** Body for creating a time-bounded pin: 60 seconds to 7 days. */
export const pinMessageSchema = z.object({
  durationSeconds: z.number().int().min(60).max(604800),
});

export type PinMessageSchema = z.infer<typeof pinMessageSchema>;

/** Body for sending a text message, optionally as a reply in the same chat. */
export const sendMessageSchema = z.object({
  body: messageBodySchema,
  replyToMessageId: z.uuid().optional(),
});

/** Body for storing opaque AES-GCM ciphertext in a secret chat. */
export const sendSecretMessageSchema = z.object({
  recipientDeviceId: z.uuid(),
  ciphertext: z
    .string()
    .min(1)
    .max(8192)
    .regex(/^[A-Za-z0-9_-]+$/),
  nonce: z.string().regex(/^[A-Za-z0-9_-]{16}$/),
  ephemeralPublicKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});

/**
 * Keyset page of message history. `cursor` is the id of the last message from
 * the previous page; ids are uuidv7, so ordering is chronological.
 */
export const listMessagesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  cursor: z.uuid().optional(),
});

/** Body for editing an owned message. */
export const editMessageSchema = z.object({
  body: messageBodySchema,
});

/** Body for forwarding a message into another chat the caller belongs to. */
export const forwardMessageSchema = z.object({
  targetChatId: z.uuid(),
});

const optionalMediaMetadata = {
  caption: z.string().trim().min(1).max(1000).optional(),
  durationMs: z.number().int().min(1).max(86_400_000).optional(),
  width: z.number().int().min(1).max(16_384).optional(),
  height: z.number().int().min(1).max(16_384).optional(),
  replyToMessageId: z.uuid().optional(),
};

export const sendMediaMessageSchema = z.object({
  mediaId: z.uuid(),
  kind: mediaKindSchema,
  ...optionalMediaMetadata,
});

export type SendMessageSchema = z.infer<typeof sendMessageSchema>;
export type ListMessagesQuerySchema = z.infer<typeof listMessagesQuerySchema>;
export type SendMediaMessageSchema = z.infer<typeof sendMediaMessageSchema>;
