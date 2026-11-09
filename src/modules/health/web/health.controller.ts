import type { RequestHandler } from 'express';
import { inject, injectable } from 'inversify';
import { CORE_TYPES } from '@/core/container/core.types.js';
import type { ApiResponse } from '@/core/http/response/api-response.js';
import { HEALTH_TYPES } from '@/modules/health/health.types.js';
import type { HealthService } from '@/modules/health/logic/health.service.js';

@injectable()
export class HealthController {
  constructor(
    @inject(HEALTH_TYPES.HealthService)
    private readonly health: HealthService,
    @inject(CORE_TYPES.ApiResponse) private readonly response: ApiResponse,
  ) {}

  check: RequestHandler = async (_req, res) => {
    const report = await this.health.check();

    this.response.send(res, report.status === 'ok' ? 200 : 503, report);
  };
}
