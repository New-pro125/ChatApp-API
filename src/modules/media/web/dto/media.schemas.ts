import { z } from 'zod';

/** Body for requesting a presigned upload. Size limits are enforced by config. */
export const createUploadSchema = z.object({
  contentType: z.string().min(1).max(128),
  sizeBytes: z.number().int().positive(),
});

export const mediaParamsSchema = z.object({ id: z.uuid() });

export const uploadTicketSchema = z
  .object({
    mediaId: z.uuid(),
    objectKey: z.string(),
    uploadUrl: z.url(),
    headers: z.object({
      'Content-Type': z.string(),
      'Content-Length': z.string(),
    }),
    expiresAt: z.iso.datetime(),
  })
  .meta({ id: 'UploadTicket' });

export const downloadTicketSchema = z
  .object({
    mediaId: z.uuid(),
    status: z.literal('ready'),
    contentType: z.string(),
    sizeBytes: z.number().int().positive(),
    sha256: z.string().nullable(),
    downloadUrl: z.url(),
    expiresAt: z.iso.datetime(),
  })
  .meta({ id: 'DownloadTicket' });

export type CreateUploadSchema = z.infer<typeof createUploadSchema>;
