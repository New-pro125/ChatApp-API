import { timingSafeEqual } from 'node:crypto';
import { type RequestHandler, Router } from 'express';
import { inject, injectable } from 'inversify';
import type { AppConfig } from '@/core/config/app.config.js';
import { CORE_TYPES } from '@/core/container/core.types.js';
import type { MetricsService } from '@/core/metrics/metrics.service.js';

/**
 * Exposes the Prometheus scrape endpoint.
 *
 * Metrics are plain text, not the JSON envelope, so this router intentionally
 * bypasses `DocumentedRouter` and `ApiResponse`. When `METRICS_TOKEN` is set the
 * caller must send `Authorization: Bearer <token>`.
 */
@injectable()
export class MetricsRouter {
  readonly router: Router = Router();

  constructor(
    @inject(CORE_TYPES.Metrics) metrics: MetricsService,
    @inject(CORE_TYPES.Config) config: AppConfig,
  ) {
    if (config.http.metricsToken !== undefined) {
      this.router.use(MetricsRouter.bearerAuth(config.http.metricsToken));
    }

    const handler: RequestHandler = async (_req, res) => {
      const body = await metrics.metrics();

      res.setHeader('Content-Type', metrics.contentType);
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).send(body);
    };

    this.router.get('/', handler);
  }

  private static bearerAuth(expected: string): RequestHandler {
    return (req, res, next) => {
      const header = req.header('authorization');
      const prefix = 'Bearer ';
      const supplied = header?.startsWith(prefix) === true ? header.slice(prefix.length) : '';

      if (MetricsRouter.safeEqual(supplied, expected)) {
        next();
        return;
      }

      res.setHeader('WWW-Authenticate', 'Bearer');
      res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Metrics access requires a bearer token' },
        meta: { requestId: req.requestId },
      });
    };
  }

  private static safeEqual(left: string, right: string): boolean {
    const leftBuffer = Buffer.from(left);
    const rightBuffer = Buffer.from(right);

    return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
  }
}
