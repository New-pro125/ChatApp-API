import { z } from 'zod';

/**
 * An opaque media object key.
 *
 * Until the media pipeline (Phase 2.4) exists the key is supplied by the
 * client, so the shape is validated defensively: a leading alphanumeric and a
 * safe character set, with `..` rejected to rule out path traversal if the key
 * is ever used to build a storage path.
 */
export const storyMediaKeySchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/, 'mediaKey must be a valid object key')
  .refine((value) => !value.includes('..'), 'mediaKey must not contain ".."');

/** Body for creating a story: a caption, a media key, or both. */
export const createStorySchema = z
  .object({
    caption: z.string().min(1).max(700).optional(),
    mediaKey: storyMediaKeySchema.optional(),
  })
  .refine((value) => value.caption !== undefined || value.mediaKey !== undefined, {
    message: 'A story requires a caption or a media key',
  });

/** Route parameter identifying a story to delete. */
export const storyParamsSchema = z.object({
  id: z.uuid(),
});

/** Route parameter identifying a user whose stories to read. */
export const userStoriesParamsSchema = z.object({
  userId: z.uuid(),
});

export type CreateStorySchema = z.infer<typeof createStorySchema>;
