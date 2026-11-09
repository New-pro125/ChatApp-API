import { inject, injectable, multiInject } from 'inversify';
import type { AppConfig } from '@/core/config/app.config.js';
import { CORE_TYPES } from '@/core/container/core.types.js';
import { HEALTH_TYPES } from '@/modules/health/health.types.js';
import type { HealthCheck } from '@/modules/health/logic/health-check.js';

export interface LiveReport {
  status: 'ok';
}

export interface HealthReport {
  status: 'ok' | 'degraded';
  checks: Record<string, 'up' | 'down'>;
}

/**
 * Runs readiness checks behind a short TTL.
 *
 * Load balancers and orchestrators probe readiness frequently. Coalescing
 * concurrent probes into a single in-flight run and caching the result for a
 * few seconds prevents a probe storm from turning into a database connection
 * storm.
 */
@injectable()
export class HealthService {
  private cached: { report: HealthReport; expiresAt: number } | null = null;
  private inFlight: Promise<HealthReport> | null = null;

  constructor(
    @multiInject(HEALTH_TYPES.HealthCheck)
    private readonly checks: HealthCheck[],
    @inject(CORE_TYPES.Config) private readonly config: AppConfig,
  ) {}

  live(): LiveReport {
    return { status: 'ok' };
  }

  async check(): Promise<HealthReport> {
    const now = Date.now();
    const ttl = this.config.http.healthCacheTtlMs;

    if (ttl > 0 && this.cached !== null && this.cached.expiresAt > now) {
      return this.cached.report;
    }

    if (this.inFlight !== null) {
      return this.inFlight;
    }

    this.inFlight = this.run().finally(() => {
      this.inFlight = null;
    });

    const report = await this.inFlight;

    if (ttl > 0) {
      this.cached = { report, expiresAt: Date.now() + ttl };
    }

    return report;
  }

  private async run(): Promise<HealthReport> {
    const results = await Promise.all(
      this.checks.map(async (check): Promise<readonly [string, 'up' | 'down']> => {
        try {
          await check.check();
          return [check.name, 'up'] as const;
        } catch {
          return [check.name, 'down'] as const;
        }
      }),
    );

    const healthy = results.every(([, status]) => status === 'up');

    return {
      status: healthy ? 'ok' : 'degraded',
      checks: Object.fromEntries(results),
    };
  }
}
