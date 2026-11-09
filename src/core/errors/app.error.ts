import type { ErrorCode } from '@/core/errors/error-code.js';

export interface AppErrorOptions {
  details?: unknown;
  cause?: unknown;
}

/**
 * Base class for every error the application deliberately raises.
 *
 * The code describes the problem in transport-neutral terms. Mapping a code to
 * an HTTP status and response body is the job of `error-mapper.ts`, so domain
 * and data layers never depend on HTTP.
 */
export abstract class AppError extends Error {
  abstract readonly code: ErrorCode;
  readonly details?: unknown;

  protected constructor(message: string, options?: AppErrorOptions) {
    super(message, { cause: options?.cause });
    this.name = new.target.name;
    this.details = options?.details;
  }
}
