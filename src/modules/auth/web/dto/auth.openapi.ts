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
  exchangeGrantSchema,
  forgotPasswordSchema,
  loginSchema,
  logoutSchema,
  mfaCodeRequestSchema,
  refreshSchema,
  registerSchema,
  resetPasswordSchema,
  revokeSessionParamsSchema,
  verifyEmailSchema,
  verifyMfaSchema,
  verifyOtpSchema,
} from '@/modules/auth/web/dto/auth.schemas.js';

const bearerSecurity = [{ bearerAuth: [] }] as const;

export const authenticatedUserSchema = z
  .object({
    id: z.uuid(),
    email: z.email(),
    displayName: z.string(),
    createdAt: z.iso.datetime(),
    sessionVersion: z.number().int().min(1),
    mfaEnabled: z.boolean(),
    mfaEnrolledAt: z.iso.datetime().nullable(),
    emailVerifiedAt: z.iso.datetime().nullable(),
  })
  .meta({ id: 'AuthenticatedUser' });

export const issuedTokensSchema = z
  .object({
    accessToken: z.string(),
    refreshToken: z.string(),
    tokenType: z.literal('Bearer'),
    expiresIn: z.number().int().min(1),
    refreshExpiresAt: z.iso.datetime(),
  })
  .meta({ id: 'IssuedTokens' });

export const authenticationResultSchema = z
  .object({
    user: authenticatedUserSchema,
    tokens: issuedTokensSchema,
  })
  .meta({ id: 'AuthenticationResult' });

export const activeSessionSchema = z
  .object({
    id: z.uuid(),
    deviceName: z.string().nullable(),
    deviceType: z.string().nullable(),
    clientIp: z.string().nullable(),
    userAgent: z.string().nullable(),
    createdAt: z.iso.datetime(),
    lastUsedAt: z.iso.datetime().nullable(),
    expiresAt: z.iso.datetime(),
    current: z.boolean(),
  })
  .meta({ id: 'ActiveSession' });

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
const authenticationResponse = successEnvelope(
  authenticationResultSchema,
  'AuthenticationResultResponse',
);
const mfaChallengeResponse = successEnvelope(mfaChallengeSchema, 'MfaChallengeResponse');
const enrollmentResponse = successEnvelope(mfaEnrollmentStartSchema, 'MfaEnrollmentStartResponse');
const recoveryCodesResponse = successEnvelope(recoveryCodesSchema, 'MfaRecoveryCodesResponse');
const mfaStatusResponse = successEnvelope(mfaStatusSchema, 'MfaStatusResponse');
const resetTokenResponse = successEnvelope(resetTokenSchema, 'PasswordResetTokenResponse');
const sessionsResponse = successEnvelope(z.array(activeSessionSchema), 'ActiveSessionListResponse');
const nullResponse = successEnvelope(z.null());

const conflict = {
  description: 'The resource already exists or the operation is not allowed in this state',
  schema: apiErrorResponseSchema,
};

const serviceUnavailable = {
  description: 'A required upstream service is temporarily unavailable',
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
    description: 'Creates an account and returns its access and refresh tokens.',
    request: { body: registerSchema },
    responses: {
      201: { description: 'Account created', schema: authenticationResponse },
      ...commonErrorResponses,
      409: conflict,
      503: serviceUnavailable,
    },
  },
  login: {
    operationId: 'auth.login',
    tags: ['Auth'],
    summary: 'Log in with email and password',
    description:
      'Verifies the captcha token before credentials. Returns 202 with a single-use MFA challenge when the account has MFA enabled; no tokens are issued until the challenge is verified.',
    request: { body: loginSchema },
    responses: {
      200: { description: 'Authenticated', schema: authenticationResponse },
      202: { description: 'MFA challenge required', schema: mfaChallengeResponse },
      ...commonErrorResponses,
      503: serviceUnavailable,
    },
  },
  logout: {
    operationId: 'auth.logout',
    tags: ['Auth'],
    summary: 'Log out the current device',
    description:
      'Revokes the presented access token immediately and, when the refresh token is supplied, stops its lineage from refreshing.',
    security: bearerSecurity,
    request: { body: logoutSchema },
    responses: {
      204: noContentResponse,
      ...commonErrorResponses,
    },
  },
  logoutAll: {
    operationId: 'auth.logoutAll',
    tags: ['Auth'],
    summary: 'Log out every device',
    description:
      'Bumps the session version and revokes every refresh token, so all outstanding tokens are rejected immediately.',
    security: bearerSecurity,
    responses: {
      204: noContentResponse,
      ...commonErrorResponses,
    },
  },
  me: {
    operationId: 'auth.me',
    tags: ['Auth'],
    summary: 'Return the authenticated user',
    security: bearerSecurity,
    responses: {
      200: { description: 'Authenticated user', schema: userResponse },
      ...commonErrorResponses,
    },
  },
  resendEmailVerification: {
    operationId: 'auth.email.resend',
    tags: ['Email verification'],
    summary: 'Send a new email verification code',
    description:
      'Issues a fresh single-use code after the resend cooldown has elapsed and invalidates any older active code.',
    security: bearerSecurity,
    responses: {
      202: { description: 'Verification code sent', schema: nullResponse },
      ...commonErrorResponses,
      409: conflict,
    },
  },
  verifyEmail: {
    operationId: 'auth.email.verify',
    tags: ['Email verification'],
    summary: 'Confirm the email address with a verification code',
    description:
      'Consumes the active code and marks the authenticated account as verified. Codes expire, are attempt-limited, and can only be used once.',
    security: bearerSecurity,
    request: { body: verifyEmailSchema },
    responses: {
      204: noContentResponse,
      ...commonErrorResponses,
    },
  },
  verifyMfa: {
    operationId: 'auth.mfa.verify',
    tags: ['MFA'],
    summary: 'Complete a pending MFA challenge',
    request: { body: verifyMfaSchema },
    responses: {
      200: { description: 'MFA verified and tokens issued', schema: authenticationResponse },
      ...commonErrorResponses,
    },
  },
  enrollMfa: {
    operationId: 'auth.mfa.enroll',
    tags: ['MFA'],
    summary: 'Start TOTP enrollment',
    security: bearerSecurity,
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
    security: bearerSecurity,
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
    security: bearerSecurity,
    responses: {
      200: { description: 'MFA status', schema: mfaStatusResponse },
      ...commonErrorResponses,
    },
  },
  disableMfa: {
    operationId: 'auth.mfa.disable',
    tags: ['MFA'],
    summary: 'Disable MFA after verifying a TOTP code',
    security: bearerSecurity,
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
    security: bearerSecurity,
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
    description:
      'Increments the session version and revokes every refresh token, invalidating all previous tokens.',
    request: { body: resetPasswordSchema },
    responses: {
      204: noContentResponse,
      ...commonErrorResponses,
    },
  },
} satisfies Record<string, RouteContract>;

export const tokenContracts = {
  refresh: {
    operationId: 'auth.token.refresh',
    tags: ['Auth'],
    summary: 'Exchange a refresh token for a new token pair',
    description:
      'Refresh tokens are single-use; every call rotates the token. Presenting a rotated or revoked token revokes the whole token family.',
    request: { body: refreshSchema },
    responses: {
      200: { description: 'Rotated token pair', schema: authenticationResponse },
      ...commonErrorResponses,
    },
  },
  exchangeGrant: {
    operationId: 'auth.token.grant',
    tags: ['Auth'],
    summary: 'Exchange an OAuth grant code for tokens',
    description:
      'Browser OAuth callbacks redirect with a single-use grant code; the client exchanges it once for the token pair.',
    request: { body: exchangeGrantSchema },
    responses: {
      200: { description: 'Token pair issued', schema: authenticationResponse },
      ...commonErrorResponses,
    },
  },
  listSessions: {
    operationId: 'auth.sessions.list',
    tags: ['Auth'],
    summary: 'List the active sessions of the current user',
    security: bearerSecurity,
    responses: {
      200: { description: 'Active sessions, newest first', schema: sessionsResponse },
      ...commonErrorResponses,
    },
  },
  revokeSession: {
    operationId: 'auth.sessions.revoke',
    tags: ['Auth'],
    summary: 'Revoke one session of the current user',
    description:
      'Marks the refresh token inactive and denies its outstanding access tokens. Use this to sign out another device.',
    security: bearerSecurity,
    request: { params: revokeSessionParamsSchema },
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
