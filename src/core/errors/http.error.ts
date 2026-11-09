import { AppError, type AppErrorOptions } from '@/core/errors/app.error.js';
import { ErrorCode } from '@/core/errors/error-code.js';

/** An error that already knows the HTTP status it should be returned with. */
export class HttpException extends AppError {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    options?: AppErrorOptions,
  ) {
    super(message, options);
  }
}

export class BadRequestException extends HttpException {
  constructor(message = 'Bad request', options?: AppErrorOptions) {
    super(400, ErrorCode.VALIDATION_ERROR, message, options);
  }
}

export class UnauthorizedException extends HttpException {
  constructor(message = 'Authentication required', options?: AppErrorOptions) {
    super(401, ErrorCode.UNAUTHORIZED, message, options);
  }
}

export class ForbiddenException extends HttpException {
  constructor(message = 'Access is forbidden', options?: AppErrorOptions) {
    super(403, ErrorCode.FORBIDDEN, message, options);
  }
}

export class NotFoundException extends HttpException {
  constructor(message = 'Resource not found', options?: AppErrorOptions) {
    super(404, ErrorCode.NOT_FOUND, message, options);
  }
}

export class ConflictException extends HttpException {
  constructor(message = 'Resource already exists', options?: AppErrorOptions) {
    super(409, ErrorCode.CONFLICT, message, options);
  }
}

export class PayloadTooLargeException extends HttpException {
  constructor(message = 'Request body is too large', options?: AppErrorOptions) {
    super(413, ErrorCode.PAYLOAD_TOO_LARGE, message, options);
  }
}

export class RateLimitedException extends HttpException {
  constructor(message = 'Too many requests. Try again later.', options?: AppErrorOptions) {
    super(429, ErrorCode.RATE_LIMITED, message, options);
  }
}

export class InternalServerErrorException extends HttpException {
  constructor(message = 'Internal server error', options?: AppErrorOptions) {
    super(500, ErrorCode.INTERNAL_ERROR, message, options);
  }
}
