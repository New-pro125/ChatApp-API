import type { Request, RequestHandler } from 'express';
import { inject, injectable } from 'inversify';
import { Counter, collectDefaultMetrics, Histogram, Registry } from 'prom-client';
import type { AppConfig } from '@/core/config/app.config.js';
import { CORE_TYPES } from '@/core/container/core.types.js';

/**
 * Owns the Prometheus registry and the HTTP instrumentation.
 *
 * The `route` label uses the matched Express route template rather than the
 * raw URL so high-cardinality values such as user ids do not explode the
 * metric series. Unmatched requests are grouped under `unmatched`.
 */
@injectable()
export class MetricsService {
  readonly registry: Registry;
  readonly middleware: RequestHandler;

  private readonly requests: Counter<'method' | 'route' | 'status'>;
  private readonly duration: Histogram<'method' | 'route' | 'status'>;

  constructor(@inject(CORE_TYPES.Config) config: AppConfig) {
    this.registry = new Registry();
    this.registry.setDefaultLabels({
      app: 'inversify-messenger',
      environment: config.nodeEnv,
    });

    collectDefaultMetrics({
      register: this.registry,
      prefix: 'messenger_',
    });

    this.requests = new Counter({
      name: 'messenger_http_requests_total',
      help: 'Total number of HTTP requests',
      labelNames: ['method', 'route', 'status'],
      registers: [this.registry],
    });

    this.duration = new Histogram({
      name: 'messenger_http_request_duration_seconds',
      help: 'HTTP request duration in seconds',
      labelNames: ['method', 'route', 'status'],
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
      registers: [this.registry],
    });

    this.middleware = (req, res, next) => {
      const startedAt = process.hrtime.bigint();

      res.once('finish', () => {
        const labels = {
          method: req.method,
          route: MetricsService.routeLabel(req),
          status: String(res.statusCode),
        };

        const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9;

        this.requests.inc(labels);
        this.duration.observe(labels, seconds);
      });

      next();
    };
  }

  get contentType(): string {
    return this.registry.contentType;
  }

  metrics(): Promise<string> {
    return this.registry.metrics();
  }

  private static routeLabel(req: Request): string {
    const route = req.route as { path?: unknown } | undefined;

    if (typeof route?.path !== 'string') {
      return req.baseUrl.length > 0 ? `${req.baseUrl}/unmatched` : 'unmatched';
    }

    const fullPath = `${req.baseUrl}${route.path}`;

    if (fullPath.length <= 1) {
      return '/';
    }

    return fullPath.endsWith('/') ? fullPath.slice(0, -1) : fullPath;
  }
}
