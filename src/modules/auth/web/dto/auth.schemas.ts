import { z } from 'zod';

const deviceContext = {
  deviceName: z.string().trim().min(1).max(100).optional(),
  deviceType: z.enum(['web', 'ios', 'android', 'desktop']).optional(),
};

export const registerSchema = z.object({
  email: z.email().max(254),
  displayName: z.string().trim().min(1).max(100),
  password: z.string().min(12).max(128),
  ...deviceContext,
});

export const loginSchema = z.object({
  email: z.email().max(254),
  password: z.string().min(1).max(128),
  ...deviceContext,
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(20).max(512),
});

export const exchangeGrantSchema = z.object({
  code: z.string().min(20).max(512),
});

export const logoutSchema = z.object({
  refreshToken: z.string().min(20).max(512).optional(),
});

export const revokeSessionParamsSchema = z.object({
  id: z.uuid(),
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
  ...deviceContext,
});

export const mfaCodeRequestSchema = z.object({
  code: totpCodeSchema,
});
