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

export class EmailAlreadyRegisteredException extends DomainException {
  readonly code = ErrorCode.CONFLICT;

  constructor(message = 'Email is already registered', options?: AppErrorOptions) {
    super(message, options);
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

export class ProviderDisabledException extends DomainException {
  readonly code = ErrorCode.PROVIDER_DISABLED;

  constructor(message = 'This identity provider is not available', options?: AppErrorOptions) {
    super(message, options);
  }
}
