import { z } from 'zod';

export const mediaKindSchema = z.enum([
  'image',
  'video',
  'document',
  'voice_note',
  'sticker',
  'gif',
]);

export const combinedMediaFieldsSchema = z.object({
  kind: mediaKindSchema,
  sizeBytes: z.coerce.number().int().positive(),
  caption: z.string().trim().min(1).max(1000).optional(),
  durationMs: z.coerce.number().int().min(1).max(86_400_000).optional(),
  width: z.coerce.number().int().min(1).max(16_384).optional(),
  height: z.coerce.number().int().min(1).max(16_384).optional(),
  replyToMessageId: z.uuid().optional(),
});

export type CombinedMediaFieldsSchema = z.infer<typeof combinedMediaFieldsSchema>;
export type MediaKind = (typeof mediaKindSchema.options)[number];
