import { z } from 'zod';

export const registerSchema = z.object({
  email: z.email().max(254),
  displayName: z.string().trim().min(1).max(100),
  password: z.string().min(12).max(128),
});

export const loginSchema = z.object({
  email: z.email().max(254),
  password: z.string().min(1).max(128),
});

export const forgotPasswordSchema = z.object({
  email: z.email().max(254),
});

export const verifyOtpSchema = z.object({
  email: z.email().max(254),
  otp: z.string().regex(/^\d{6}$/, 'OTP must be 6 digits'),
});

export const resetPasswordSchema = z.object({
  resetToken: z.string().min(20).max(512),
  newPassword: z.string().min(12).max(128),
});

export const totpCodeSchema = z.string().regex(/^\d{6}$/, 'Authenticator code must be 6 digits');

export const mfaCodeSchema = z.string().trim().min(6).max(64);

export const confirmEnrollmentSchema = z.object({
  code: totpCodeSchema,
});

export const verifyMfaSchema = z.object({
  challengeToken: z.string().min(20).max(512).optional(),
  code: mfaCodeSchema,
});

export const mfaCodeRequestSchema = z.object({
  code: totpCodeSchema,
});
