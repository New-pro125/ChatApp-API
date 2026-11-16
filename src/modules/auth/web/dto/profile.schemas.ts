import { z } from 'zod';

/**
 * Self-service profile update payload.
 *
 * Every field is optional: omitting it leaves the stored value unchanged,
 * while sending `null` clears it. Usernames are normalized to lowercase before
 * validation so lookups and uniqueness stay case-insensitive. `avatarKey` is
 * deliberately absent: it is owned by the future media pipeline and clients
 * cannot set it.
 */
export const updateProfileSchema = z
  .object({
    displayName: z.string().trim().min(1).max(100).optional(),
    username: z
      .string()
      .trim()
      .toLowerCase()
      .regex(
        /^[a-z][a-z0-9_]{4,31}$/,
        'Username must start with a letter and contain 5-32 lowercase letters, digits, or underscores',
      )
      .nullable()
      .optional(),
    bio: z.string().trim().max(70, 'Bio must be at most 70 characters').nullable().optional(),
    phone: z
      .string()
      .trim()
      .regex(/^\+[1-9][0-9]{7,14}$/, 'Phone must be an E.164 number such as +15551234567')
      .nullable()
      .optional(),
  })
  .refine((value) => Object.values(value).some((field) => field !== undefined), {
    message: 'At least one profile field must be provided',
  });

export type UpdateProfileSchema = z.infer<typeof updateProfileSchema>;
