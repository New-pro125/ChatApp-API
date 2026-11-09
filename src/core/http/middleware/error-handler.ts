import type { ErrorRequestHandler } from 'express';
import type { Logger } from 'pino';
import type { ErrorMapper } from '@/core/errors/error-mapper.js';
import type { ApiResponse } from '@/core/http/response/api-response.js';

export class ErrorHandlerMiddleware {
  readonly handle: ErrorRequestHandler;

  constructor(
    private readonly logger: Logger,
    private readonly mapper: ErrorMapper,
    private readonly response: ApiResponse,
  ) {
    this.handle = (error, req, res, next) => {
      if (res.headersSent) {
        next(error);
        return;
      }

      const mapping = this.mapper.map(error);

      if (mapping.retryAfterSeconds !== undefined) {
        res.setHeader('Retry-After', String(mapping.retryAfterSeconds));
      }

      if (mapping.shouldLog) {
        this.logger.error(
          {
            err: error,
            requestId: req.requestId,
            code: mapping.code,
            status: mapping.status,
          },
          'Request failed',
        );
      }

      this.response.fail(res, mapping.status, {
        code: mapping.code,
        message: mapping.message,
        ...(mapping.details === undefined ? {} : { details: mapping.details }),
      });
    };
  }
}
