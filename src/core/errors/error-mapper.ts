import { inject, injectable } from 'inversify';
import { ZodError } from 'zod';
import type { AppConfig } from '@/core/config/app.config.js';
import { CORE_TYPES } from '@/core/container/core.types.js';
import type { AppError } from '@/core/errors/app.error.js';
import { DomainException } from '@/core/errors/domain.error.js';
import { ErrorCode } from '@/core/errors/error-code.js';
import { HttpException } from '@/core/errors/http.error.js';
import { UniqueConstraintException } from '@/core/errors/repository.error.js';

export interface ErrorMapping {
  status: number;
  code: ErrorCode;
  message: string;
  details?: unknown;
  retryAfterSeconds?: number;
  shouldLog: boolean;
}

const STATUS_BY_DOMAIN_CODE: Partial<Record<ErrorCode, number>> = {
  [ErrorCode.VALIDATION_ERROR]: 400,
  [ErrorCode.UNAUTHORIZED]: 401,
  [ErrorCode.FORBIDDEN]: 403,
  [ErrorCode.NOT_FOUND]: 404,
  [ErrorCode.CONFLICT]: 409,
  [ErrorCode.ACCOUNT_LOCKED]: 423,
  [ErrorCode.EMAIL_NOT_VERIFIED]: 403,
  [ErrorCode.USER_BLOCKED]: 403,
  [ErrorCode.NOT_CHAT_MEMBER]: 403,
  [ErrorCode.CAPTCHA_REQUIRED]: 400,
  [ErrorCode.CAPTCHA_INVALID]: 400,
  [ErrorCode.CAPTCHA_UNAVAILABLE]: 503,
  [ErrorCode.RATE_LIMITED]: 429,
  [ErrorCode.OTP_EXPIRED]: 400,
  [ErrorCode.OTP_INVALID]: 400,
  [ErrorCode.MFA_REQUIRED]: 401,
  [ErrorCode.MFA_INVALID_CODE]: 401,
  [ErrorCode.MFA_CHALLENGE_EXPIRED]: 401,
  [ErrorCode.MFA_ALREADY_ENABLED]: 409,
  [ErrorCode.MFA_NOT_ENABLED]: 409,
  [ErrorCode.MFA_NOT_ENROLLED]: 400,
  [ErrorCode.MFA_ENROLLMENT_EXPIRED]: 400,
  [ErrorCode.MFA_DISABLED]: 400,
  [ErrorCode.OAUTH_FAILED]: 401,
  [ErrorCode.PROVIDER_DISABLED]: 404,
  [ErrorCode.REFRESH_TOKEN_INVALID]: 401,
  [ErrorCode.OAUTH_GRANT_INVALID]: 401,
  [ErrorCode.E2EE_DEVICE_CONFLICT]: 409,
  [ErrorCode.E2EE_DEVICE_NOT_FOUND]: 404,
  [ErrorCode.E2EE_PREKEY_EXHAUSTED]: 409,
  [ErrorCode.E2EE_NOT_ALLOWED]: 403,
  [ErrorCode.MEDIA_SCAN_UNAVAILABLE]: 503,
  [ErrorCode.MEDIA_INFECTED]: 422,
  [ErrorCode.MEDIA_NOT_READY]: 409,
};

/**
 * Converts any thrown value into the public HTTP error contract.
 *
 * This is the only place that knows how domain and repository failures map to
 * status codes, which keeps those layers independent from Express.
 */
@injectable()
export class ErrorMapper {
  constructor(@inject(CORE_TYPES.Config) private readonly config: AppConfig) {}

  map(error: unknown): ErrorMapping {
    if (error instanceof ZodError) {
      return this.mapZodError(error);
    }

    if (this.isBodyParserError(error)) {
      return this.mapBodyParserError(error);
    }

    if (error instanceof HttpException) {
      return this.mapHttpException(error);
    }

    if (error instanceof DomainException) {
      return this.mapDomainException(error);
    }

    return this.mapUnknownError(error);
  }

  private mapZodError(error: ZodError): ErrorMapping {
    return {
      status: 400,
      code: ErrorCode.VALIDATION_ERROR,
      message: 'Invalid request',
      details: error.issues.map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
        code: issue.code,
      })),
      shouldLog: false,
    };
  }

  private mapBodyParserError(error: {
    type: 'entity.parse.failed' | 'entity.too.large';
  }): ErrorMapping {
    const tooLarge = error.type === 'entity.too.large';

    return {
      status: tooLarge ? 413 : 400,
      code: tooLarge ? ErrorCode.PAYLOAD_TOO_LARGE : ErrorCode.VALIDATION_ERROR,
      message: tooLarge ? 'Request body is too large' : 'Malformed request body',
      shouldLog: false,
    };
  }

  private mapHttpException(error: HttpException): ErrorMapping {
    const retryAfterSeconds = this.retryAfterSeconds(error);

    return {
      status: error.status,
      code: error.code,
      message: error.message,
      details: error.details,
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
      shouldLog: error.status >= 500,
    };
  }

  private mapDomainException(error: DomainException): ErrorMapping {
    const status = STATUS_BY_DOMAIN_CODE[error.code] ?? 500;
    const retryAfterSeconds = this.retryAfterSeconds(error);

    return {
      status,
      code: error.code,
      message: error.message,
      details: error.details,
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
      shouldLog: status >= 500,
    };
  }

  private mapUnknownError(error: unknown): ErrorMapping {
    if (error instanceof UniqueConstraintException) {
      return {
        status: 409,
        code: ErrorCode.CONFLICT,
        message: 'Resource already exists',
        shouldLog: false,
      };
    }

    return {
      status: 500,
      code: ErrorCode.INTERNAL_ERROR,
      message: this.genericMessage(error),
      shouldLog: true,
    };
  }

  private retryAfterSeconds(error: AppError): number | undefined {
    const candidate = (error as { retryAfterSeconds?: unknown }).retryAfterSeconds;

    return typeof candidate === 'number' && candidate > 0 ? candidate : undefined;
  }

  private genericMessage(error: unknown): string {
    if (this.config.nodeEnv === 'production') {
      return 'Internal server error';
    }

    return error instanceof Error ? error.message : String(error);
  }

  private isBodyParserError(
    error: unknown,
  ): error is { type: 'entity.parse.failed' | 'entity.too.large' } {
    if (typeof error !== 'object' || error === null || !('type' in error)) {
      return false;
    }

    const type = (error as { type?: unknown }).type;

    return type === 'entity.parse.failed' || type === 'entity.too.large';
  }
}
