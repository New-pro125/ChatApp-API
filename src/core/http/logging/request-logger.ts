import type { Request, RequestHandler } from 'express';
import type { Logger } from 'pino';
import { pinoHttp } from 'pino-http';

/**
 * Structured request logging.
 *
 * `RequestIdMiddleware` runs first, so every log line shares the same request id
 * returned in the response envelope and the `x-request-id` header. Liveness
 * probes and metrics scrapes are skipped to keep operational logs quiet.
 */
export class RequestLoggerMiddleware {
  readonly handle: RequestHandler;

  constructor(logger: Logger) {
    this.handle = pinoHttp({
      logger,
      genReqId: (req) => (req as Request).requestId,
      autoLogging: {
        ignore: (req) =>
          req.url === '/health/live' || req.url === '/health' || req.url === '/metrics',
      },
      quietReqLogger: true,
      redact: {
        paths: [
          'req.headers.authorization',
          'req.headers.cookie',
          'req.headers["set-cookie"]',
          'res.headers["set-cookie"]',
        ],
        censor: '[redacted]',
      },
      customLogLevel: (_req, res, error) => {
        if (error !== undefined || res.statusCode >= 500) {
          return 'error';
        }

        return res.statusCode >= 400 ? 'warn' : 'info';
      },
      customSuccessMessage: (req, res) =>
        `${(req as Request).method} ${(req as Request).originalUrl} ${res.statusCode}`,
      customErrorMessage: (req, res) =>
        `${(req as Request).method} ${(req as Request).originalUrl} ${res.statusCode}`,
      customProps: (req) => ({ requestId: (req as Request).requestId }),
    }) as RequestHandler;
  }
}
