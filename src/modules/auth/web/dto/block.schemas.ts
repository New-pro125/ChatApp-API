import { z } from 'zod';

/** Body for creating a block edge. */
export const blockUserSchema = z.object({
  userId: z.uuid(),
});

/** Route parameter identifying the block edge to remove. */
export const blockUserParamsSchema = z.object({
  userId: z.uuid(),
});
