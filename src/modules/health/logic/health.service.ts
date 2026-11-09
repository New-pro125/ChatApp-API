import { injectable, multiInject } from 'inversify';
import { HEALTH_TYPES } from '@/modules/health/health.types.js';
import type { HealthCheck } from '@/modules/health/logic/health-check.js';

export interface HealthReport {
  status: 'ok' | 'degraded';
  checks: Record<string, 'up' | 'down'>;
}

@injectable()
export class HealthService {
  constructor(
    @multiInject(HEALTH_TYPES.HealthCheck)
    private readonly checks: HealthCheck[],
  ) {}

  async check(): Promise<HealthReport> {
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
