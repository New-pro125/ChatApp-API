import type { Request, RequestHandler } from 'express';
import { inject, injectable } from 'inversify';
import { CORE_TYPES } from '@/core/container/core.types.js';
import { UnauthorizedException } from '@/core/errors/http.error.js';
import type { ApiResponse } from '@/core/http/response/api-response.js';
import { AUTH_TYPES } from '@/modules/auth/auth.types.js';
import type { BlockService } from '@/modules/auth/logic/block.service.js';
import type { AuthenticatedUser } from '@/modules/auth/logic/entities/authenticated-user.js';
import { blockUserParamsSchema, blockUserSchema } from '@/modules/auth/web/dto/block.schemas.js';

@injectable()
export class BlockController {
  constructor(
    @inject(AUTH_TYPES.BlockService) private readonly blocks: BlockService,
    @inject(CORE_TYPES.ApiResponse) private readonly response: ApiResponse,
  ) {}

  list: RequestHandler = async (req, res) => {
    const user = this.requireUser(req);
    const blocked = await this.blocks.list(user.id);

    this.response.list(res, blocked);
  };

  create: RequestHandler = async (req, res) => {
    const user = this.requireUser(req);
    const { userId } = blockUserSchema.parse(req.body);

    await this.blocks.block(user.id, userId);

    this.response.noContent(res);
  };

  remove: RequestHandler = async (req, res) => {
    const user = this.requireUser(req);
    const { userId } = blockUserParamsSchema.parse(req.params);

    await this.blocks.unblock(user.id, userId);

    this.response.noContent(res);
  };

  private requireUser(req: Request): AuthenticatedUser {
    if (!req.isAuthenticated()) {
      throw new UnauthorizedException();
    }

    return req.user;
  }
}
