import { z } from 'zod';

/**
 * Who may see a privacy-gated field. `contacts` is reserved for a later phase
 * and is intentionally rejected until the contact graph exists.
 */
export const privacyVisibilitySchema = z.enum(['everyone', 'nobody']);

/**
 * Partial privacy update payload.
 *
 * Every field is optional; at least one must be present so an empty PATCH is a
 * validation error rather than a silent no-op.
 */
export const updatePrivacySchema = z
  .object({
    profilePhotoVisibility: privacyVisibilitySchema.optional(),
    lastSeenVisibility: privacyVisibilitySchema.optional(),
    storiesVisibility: privacyVisibilitySchema.optional(),
    readReceiptsEnabled: z.boolean().optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: 'At least one privacy setting must be provided',
  });

export type UpdatePrivacySchema = z.infer<typeof updatePrivacySchema>;
