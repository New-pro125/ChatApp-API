import { z } from 'zod';

/** A text body. The database check constraint allows 1–4096 characters. */
export const messageBodySchema = z.string().min(1).max(4096);

/** Body for opening (or retrieving) a direct chat with another user. */
export const openDirectChatSchema = z.object({
  participantId: z.uuid(),
});

/** Route parameters for chat-scoped operations. */
export const chatParamsSchema = z.object({
  chatId: z.uuid(),
});

/** Route parameters for operations on a single message. */
export const messageParamsSchema = z.object({
  chatId: z.uuid(),
  messageId: z.uuid(),
});

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

export type SendMessageSchema = z.infer<typeof sendMessageSchema>;
export type ListMessagesQuerySchema = z.infer<typeof listMessagesQuerySchema>;
