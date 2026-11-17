import type { Request, RequestHandler } from 'express';
import { inject, injectable } from 'inversify';
import { CORE_TYPES } from '@/core/container/core.types.js';
import { UnauthorizedException } from '@/core/errors/http.error.js';
import type { ApiResponse } from '@/core/http/response/api-response.js';
import { AUTH_TYPES } from '@/modules/auth/auth.types.js';
import type { AuthenticatedUser } from '@/modules/auth/logic/entities/authenticated-user.js';
import type { PrivacyService } from '@/modules/auth/logic/privacy.service.js';
import { updatePrivacySchema } from '@/modules/auth/web/dto/privacy.schemas.js';

@injectable()
export class PrivacyController {
  constructor(
    @inject(AUTH_TYPES.PrivacyService) private readonly privacy: PrivacyService,
    @inject(CORE_TYPES.ApiResponse) private readonly response: ApiResponse,
  ) {}

  get: RequestHandler = async (req, res) => {
    const user = this.requireUser(req);
    const settings = await this.privacy.get(user.id);

    this.response.ok(res, settings);
  };

  update: RequestHandler = async (req, res) => {
    const user = this.requireUser(req);
    const input = updatePrivacySchema.parse(req.body);
    const settings = await this.privacy.update(user.id, input);

    this.response.ok(res, settings);
  };

  private requireUser(req: Request): AuthenticatedUser {
    if (!req.isAuthenticated()) {
      throw new UnauthorizedException();
    }

    return req.user;
  }
}
