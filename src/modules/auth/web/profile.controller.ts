import type { Request, RequestHandler } from 'express';
import { inject, injectable } from 'inversify';
import { CORE_TYPES } from '@/core/container/core.types.js';
import { UnauthorizedException } from '@/core/errors/http.error.js';
import type { ApiResponse } from '@/core/http/response/api-response.js';
import { AUTH_TYPES } from '@/modules/auth/auth.types.js';
import type { AuthenticatedUser } from '@/modules/auth/logic/entities/authenticated-user.js';
import type { ProfileService } from '@/modules/auth/logic/profile.service.js';
import { updateProfileSchema } from '@/modules/auth/web/dto/profile.schemas.js';

@injectable()
export class ProfileController {
  constructor(
    @inject(AUTH_TYPES.ProfileService) private readonly profiles: ProfileService,
    @inject(CORE_TYPES.ApiResponse) private readonly response: ApiResponse,
  ) {}

  update: RequestHandler = async (req, res) => {
    const user = this.requireUser(req);
    const input = updateProfileSchema.parse(req.body);

    const updated = await this.profiles.update(user.id, input);

    this.response.ok(res, updated);
  };

  private requireUser(req: Request): AuthenticatedUser {
    if (!req.isAuthenticated()) {
      throw new UnauthorizedException();
    }

    return req.user;
  }
}
