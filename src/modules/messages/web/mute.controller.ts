import type { Request, RequestHandler } from 'express';
import { inject, injectable } from 'inversify';
import { CORE_TYPES } from '@/core/container/core.types.js';
import { UnauthorizedException } from '@/core/errors/http.error.js';
import type { ApiResponse } from '@/core/http/response/api-response.js';
import type { MuteService } from '@/modules/messages/logic/mute.service.js';
import { MESSAGES_TYPES } from '@/modules/messages/messages.types.js';
import { chatParamsSchema, setMuteSchema } from '@/modules/messages/web/dto/message.schemas.js';

/** Request-scoped handlers for the caller's per-chat mute setting. */
@injectable()
export class MuteController {
  constructor(
    @inject(MESSAGES_TYPES.MuteService) private readonly mutes: MuteService,
    @inject(CORE_TYPES.ApiResponse) private readonly response: ApiResponse,
  ) {}

  set: RequestHandler = async (req, res) => {
    const user = this.requireUser(req);
    const { chatId } = chatParamsSchema.parse(req.params);
    const { preset } = setMuteSchema.parse(req.body);
    const result = await this.mutes.setMute(user.id, chatId, preset);

    this.response.ok(res, result);
  };

  private requireUser(req: Request): Express.User {
    if (!req.isAuthenticated()) {
      throw new UnauthorizedException();
    }

    return req.user;
  }
}
