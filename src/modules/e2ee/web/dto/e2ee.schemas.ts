import { z } from 'zod';

const base64url = (bytes: number) =>
  z.string().regex(new RegExp(`^[A-Za-z0-9_-]{${Math.ceil((bytes * 4) / 3)}}$`));

export const oneTimePrekeySchema = z.object({
  id: z.number().int().positive(),
  publicKey: base64url(32),
});

export const deviceRegistrationSchema = z.object({
  signingPublicKey: base64url(32),
  identityPublicKey: base64url(32),
  identitySignature: base64url(64),
  signedPrekey: z.object({
    id: z.number().int().positive(),
    publicKey: base64url(32),
    signature: base64url(64),
  }),
  oneTimePrekeys: z.array(oneTimePrekeySchema).min(1).max(100),
});

export const prekeyReplenishmentSchema = z.object({
  oneTimePrekeys: z.array(oneTimePrekeySchema).min(1).max(100),
});

export const userParamsSchema = z.object({ userId: z.uuid() });
export const bundleParamsSchema = z.object({ userId: z.uuid(), deviceId: z.uuid() });
