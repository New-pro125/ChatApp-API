/// <reference types="zod-openapi" />
import { z } from 'zod';
import {
  apiErrorResponseSchema,
  commonErrorResponses,
  noContentResponse,
  successEnvelope,
} from '@/core/http/openapi/openapi.schemas.js';
import type { RouteContract } from '@/core/http/openapi/openapi.types.js';
import {
  confirmEnrollmentSchema,
  forgotPasswordSchema,
  loginSchema,
  mfaCodeRequestSchema,
  registerSchema,
  resetPasswordSchema,
  verifyMfaSchema,
  verifyOtpSchema,
} from '@/modules/auth/web/dto/auth.schemas.js';

const sessionSecurity = [{ sessionCookie: [] }] as const;

export const authenticatedUserSchema = z
  .object({
    id: z.uuid(),
    email: z.email(),
    displayName: z.string(),
    createdAt: z.iso.datetime(),
    sessionVersion: z.number().int().min(1),
    mfaEnabled: z.boolean(),
    mfaEnrolledAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'AuthenticatedUser' });

export const mfaChallengeSchema = z
  .object({
    mfaRequired: z.literal(true),
    challengeToken: z.string(),
    expiresAt: z.iso.datetime(),
  })
  .meta({ id: 'MfaChallenge' });

export const mfaEnrollmentStartSchema = z
  .object({
    secret: z.string(),
    otpauthUrl: z.string(),
    expiresAt: z.iso.datetime(),
  })
  .meta({ id: 'MfaEnrollmentStart' });

export const recoveryCodesSchema = z
  .object({ recoveryCodes: z.array(z.string()) })
  .meta({ id: 'MfaRecoveryCodes' });

export const mfaStatusSchema = z
  .object({
    available: z.boolean(),
    enabled: z.boolean(),
    enrolledAt: z.iso.datetime().nullable(),
    recoveryCodesRemaining: z.number().int().min(0),
  })
  .meta({ id: 'MfaStatus' });

export const resetTokenSchema = z
  .object({
    resetToken: z.string(),
    expiresAt: z.iso.datetime(),
  })
  .meta({ id: 'PasswordResetToken' });

const userResponse = successEnvelope(authenticatedUserSchema, 'AuthenticatedUserResponse');
const mfaChallengeResponse = successEnvelope(mfaChallengeSchema, 'MfaChallengeResponse');
const enrollmentResponse = successEnvelope(mfaEnrollmentStartSchema, 'MfaEnrollmentStartResponse');
const recoveryCodesResponse = successEnvelope(recoveryCodesSchema, 'MfaRecoveryCodesResponse');
const mfaStatusResponse = successEnvelope(mfaStatusSchema, 'MfaStatusResponse');
const resetTokenResponse = successEnvelope(resetTokenSchema, 'PasswordResetTokenResponse');
const nullResponse = successEnvelope(z.null());

const conflict = {
  description: 'The resource already exists or the operation is not allowed in this state',
  schema: apiErrorResponseSchema,
};

/**
 * OpenAPI contracts for the authentication module.
 *
 * Each request schema is the same Zod schema the controller parses, so the
 * documentation and validation cannot drift apart.
 */
export const authContracts = {
  register: {
    operationId: 'auth.register',
    tags: ['Auth'],
    summary: 'Register a new account',
    description: 'Creates an account, starts a session, and sends an email verification code.',
    request: { body: registerSchema },
    responses: {
      201: { description: 'Account created', schema: userResponse },
      ...commonErrorResponses,
      409: conflict,
    },
  },
  login: {
    operationId: 'auth.login',
    tags: ['Auth'],
    summary: 'Log in with email and password',
    description:
      'Returns 202 with a single-use MFA challenge when the account has MFA enabled; no session is created until the challenge is verified.',
    request: { body: loginSchema },
    responses: {
      200: { description: 'Authenticated', schema: userResponse },
      202: { description: 'MFA challenge required', schema: mfaChallengeResponse },
      ...commonErrorResponses,
    },
  },
  logout: {
    operationId: 'auth.logout',
    tags: ['Auth'],
    summary: 'Log out the current session',
    responses: {
      204: noContentResponse,
      ...commonErrorResponses,
    },
  },
  me: {
    operationId: 'auth.me',
    tags: ['Auth'],
    summary: 'Return the authenticated user',
    security: sessionSecurity,
    responses: {
      200: { description: 'Authenticated user', schema: userResponse },
      ...commonErrorResponses,
    },
  },
  verifyMfa: {
    operationId: 'auth.mfa.verify',
    tags: ['MFA'],
    summary: 'Complete a pending MFA challenge',
    request: { body: verifyMfaSchema },
    responses: {
      200: { description: 'MFA verified and session created', schema: userResponse },
      ...commonErrorResponses,
    },
  },
  enrollMfa: {
    operationId: 'auth.mfa.enroll',
    tags: ['MFA'],
    summary: 'Start TOTP enrollment',
    security: sessionSecurity,
    responses: {
      200: { description: 'TOTP secret and otpauth URI', schema: enrollmentResponse },
      ...commonErrorResponses,
      409: conflict,
    },
  },
  confirmMfaEnrollment: {
    operationId: 'auth.mfa.enroll.confirm',
    tags: ['MFA'],
    summary: 'Confirm TOTP enrollment and receive recovery codes',
    security: sessionSecurity,
    request: { body: confirmEnrollmentSchema },
    responses: {
      200: { description: 'MFA enabled and recovery codes issued', schema: recoveryCodesResponse },
      ...commonErrorResponses,
      409: conflict,
    },
  },
  mfaStatus: {
    operationId: 'auth.mfa.status',
    tags: ['MFA'],
    summary: 'Return MFA enrollment status',
    security: sessionSecurity,
    responses: {
      200: { description: 'MFA status', schema: mfaStatusResponse },
      ...commonErrorResponses,
    },
  },
  disableMfa: {
    operationId: 'auth.mfa.disable',
    tags: ['MFA'],
    summary: 'Disable MFA after verifying a TOTP code',
    security: sessionSecurity,
    request: { body: mfaCodeRequestSchema },
    responses: {
      204: noContentResponse,
      ...commonErrorResponses,
      409: conflict,
    },
  },
  regenerateRecoveryCodes: {
    operationId: 'auth.mfa.recovery-codes.regenerate',
    tags: ['MFA'],
    summary: 'Replace recovery codes after verifying a TOTP code',
    security: sessionSecurity,
    request: { body: mfaCodeRequestSchema },
    responses: {
      200: { description: 'New recovery codes', schema: recoveryCodesResponse },
      ...commonErrorResponses,
      409: conflict,
    },
  },
  forgotPassword: {
    operationId: 'auth.password.forgot',
    tags: ['Password'],
    summary: 'Request a password reset code',
    description: 'Always returns 202 so callers cannot probe which emails are registered.',
    request: { body: forgotPasswordSchema },
    responses: {
      202: { description: 'Request accepted', schema: nullResponse },
      ...commonErrorResponses,
    },
  },
  verifyPasswordOtp: {
    operationId: 'auth.password.verify-otp',
    tags: ['Password'],
    summary: 'Exchange a reset OTP for a single-use reset token',
    request: { body: verifyOtpSchema },
    responses: {
      200: { description: 'Reset token issued', schema: resetTokenResponse },
      ...commonErrorResponses,
    },
  },
  resetPassword: {
    operationId: 'auth.password.reset',
    tags: ['Password'],
    summary: 'Set a new password with a reset token',
    description: 'Increments the session version, invalidating all previous sessions.',
    request: { body: resetPasswordSchema },
    responses: {
      204: noContentResponse,
      ...commonErrorResponses,
    },
  },
} satisfies Record<string, RouteContract>;

export const oauthBeginContract = (provider: string): RouteContract => ({
  operationId: `auth.oauth.${provider}.begin`,
  tags: ['OAuth'],
  summary: `Start ${provider} login`,
  description: 'Redirects the browser to the identity provider.',
  responses: {
    302: { description: 'Redirect to the identity provider' },
    ...commonErrorResponses,
  },
});

export const oauthCallbackContract = (provider: string): RouteContract => ({
  operationId: `auth.oauth.${provider}.callback`,
  tags: ['OAuth'],
  summary: `Complete ${provider} login`,
  description:
    'Creates a session for verified provider emails, or returns an MFA challenge when MFA is enabled.',
  responses: {
    200: { description: 'Authenticated', schema: userResponse },
    202: { description: 'MFA challenge required', schema: mfaChallengeResponse },
    302: { description: 'Redirect to the web application' },
    ...commonErrorResponses,
  },
});
