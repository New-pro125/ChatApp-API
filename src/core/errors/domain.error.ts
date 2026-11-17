import { AppError, type AppErrorOptions } from '@/core/errors/app.error.js';
import { ErrorCode } from '@/core/errors/error-code.js';

/**
 * A business-rule or application-flow failure.
 *
 * Domain errors intentionally carry no HTTP status. The global error mapper
 * translates their codes into the public HTTP contract.
 */
export abstract class DomainException extends AppError {}

export class InvalidCredentialsException extends DomainException {
  readonly code = ErrorCode.UNAUTHORIZED;

  constructor(message = 'Invalid email or password', options?: AppErrorOptions) {
    super(message, options);
  }
}

export class InvalidAccessTokenException extends DomainException {
  readonly code = ErrorCode.UNAUTHORIZED;

  constructor(message = 'Access token is invalid or expired', options?: AppErrorOptions) {
    super(message, options);
  }
}

export class InvalidRefreshTokenException extends DomainException {
  readonly code = ErrorCode.REFRESH_TOKEN_INVALID;

  constructor(
    message = 'Refresh token is invalid, expired, or revoked',
    options?: AppErrorOptions,
  ) {
    super(message, options);
  }
}

export class EmailAlreadyRegisteredException extends DomainException {
  readonly code = ErrorCode.CONFLICT;

  constructor(message = 'Email is already registered', options?: AppErrorOptions) {
    super(message, options);
  }
}

export class EmailNotVerifiedException extends DomainException {
  readonly code = ErrorCode.EMAIL_NOT_VERIFIED;

  constructor(
    message = 'Email verification is required to perform this action',
    options?: AppErrorOptions,
  ) {
    super(message, options);
  }
}

export class EmailAlreadyVerifiedException extends DomainException {
  readonly code = ErrorCode.CONFLICT;

  constructor(message = 'Email address is already verified', options?: AppErrorOptions) {
    super(message, options);
  }
}

export class UsernameAlreadyTakenException extends DomainException {
  readonly code = ErrorCode.CONFLICT;

  constructor(message = 'Username is already taken', options?: AppErrorOptions) {
    super(message, options);
  }
}

export class PhoneAlreadyRegisteredException extends DomainException {
  readonly code = ErrorCode.CONFLICT;

  constructor(message = 'Phone number is already registered', options?: AppErrorOptions) {
    super(message, options);
  }
}

export class UserNotFoundException extends DomainException {
  readonly code = ErrorCode.NOT_FOUND;

  constructor(message = 'User not found', options?: AppErrorOptions) {
    super(message, options);
  }
}

export class CaptchaRequiredException extends DomainException {
  readonly code = ErrorCode.CAPTCHA_REQUIRED;

  constructor(message = 'Captcha verification is required', options?: AppErrorOptions) {
    super(message, options);
  }
}

export class CaptchaInvalidException extends DomainException {
  readonly code = ErrorCode.CAPTCHA_INVALID;

  constructor(message = 'Captcha verification failed', options?: AppErrorOptions) {
    super(message, options);
  }
}

export class CaptchaUnavailableException extends DomainException {
  readonly code = ErrorCode.CAPTCHA_UNAVAILABLE;

  constructor(
    message = 'Captcha verification is temporarily unavailable',
    options?: AppErrorOptions,
  ) {
    super(message, options);
  }
}

export class ResendCooldownException extends DomainException {
  readonly code = ErrorCode.RATE_LIMITED;
  readonly retryAfterSeconds: number;

  constructor(retryAfterSeconds: number, options?: AppErrorOptions) {
    super(`Please wait ${retryAfterSeconds} seconds before requesting another verification code`, {
      ...options,
      details: { retryAfterSeconds },
    });
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class AccountLockedException extends DomainException {
  readonly code = ErrorCode.ACCOUNT_LOCKED;
  readonly retryAfterSeconds: number;

  constructor(
    retryAfterSeconds: number,
    message = 'Account temporarily locked due to too many failed login attempts.',
    options?: AppErrorOptions,
  ) {
    super(message, { ...options, details: { retryAfterSeconds } });
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class OtpInvalidException extends DomainException {
  readonly code = ErrorCode.OTP_INVALID;

  constructor(message = 'Invalid or expired reset code', options?: AppErrorOptions) {
    super(message, options);
  }
}

export class OtpExpiredException extends DomainException {
  readonly code = ErrorCode.OTP_EXPIRED;

  constructor(message = 'Reset code has expired', options?: AppErrorOptions) {
    super(message, options);
  }
}

export class MfaRequiredException extends DomainException {
  readonly code = ErrorCode.MFA_REQUIRED;

  constructor(
    message = 'A two-factor authentication challenge is required',
    options?: AppErrorOptions,
  ) {
    super(message, options);
  }
}

export class MfaInvalidCodeException extends DomainException {
  readonly code = ErrorCode.MFA_INVALID_CODE;

  constructor(message = 'Invalid two-factor authentication code', options?: AppErrorOptions) {
    super(message, options);
  }
}

export class MfaChallengeExpiredException extends DomainException {
  readonly code = ErrorCode.MFA_CHALLENGE_EXPIRED;

  constructor(
    message = 'The two-factor challenge is invalid or expired',
    options?: AppErrorOptions,
  ) {
    super(message, options);
  }
}

export class MfaAlreadyEnabledException extends DomainException {
  readonly code = ErrorCode.MFA_ALREADY_ENABLED;

  constructor(message = 'Two-factor authentication is already enabled', options?: AppErrorOptions) {
    super(message, options);
  }
}

export class MfaNotEnabledException extends DomainException {
  readonly code = ErrorCode.MFA_NOT_ENABLED;

  constructor(message = 'Two-factor authentication is not enabled', options?: AppErrorOptions) {
    super(message, options);
  }
}

export class MfaNotEnrolledException extends DomainException {
  readonly code = ErrorCode.MFA_NOT_ENROLLED;

  constructor(message = 'Two-factor enrollment has not been started', options?: AppErrorOptions) {
    super(message, options);
  }
}

export class MfaEnrollmentExpiredException extends DomainException {
  readonly code = ErrorCode.MFA_ENROLLMENT_EXPIRED;

  constructor(message = 'The two-factor enrollment has expired', options?: AppErrorOptions) {
    super(message, options);
  }
}

export class MfaDisabledException extends DomainException {
  readonly code = ErrorCode.MFA_DISABLED;

  constructor(message = 'Two-factor authentication is not available', options?: AppErrorOptions) {
    super(message, options);
  }
}

export class OAuthFailedException extends DomainException {
  readonly code = ErrorCode.OAUTH_FAILED;

  constructor(message = 'OAuth authentication failed', options?: AppErrorOptions) {
    super(message, options);
  }
}

export class InvalidOAuthGrantException extends DomainException {
  readonly code = ErrorCode.OAUTH_GRANT_INVALID;

  constructor(
    message = 'The OAuth grant code is invalid, expired, or already used',
    options?: AppErrorOptions,
  ) {
    super(message, options);
  }
}

export class ProviderDisabledException extends DomainException {
  readonly code = ErrorCode.PROVIDER_DISABLED;

  constructor(message = 'This identity provider is not available', options?: AppErrorOptions) {
    super(message, options);
  }
}

export class CannotBlockSelfException extends DomainException {
  readonly code = ErrorCode.VALIDATION_ERROR;

  constructor(message = 'You cannot block yourself', options?: AppErrorOptions) {
    super(message, options);
  }
}
