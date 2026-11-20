import type { Request, RequestHandler } from 'express';
import { inject, injectable } from 'inversify';
import { CORE_TYPES } from '@/core/container/core.types.js';
import { UnauthorizedException } from '@/core/errors/http.error.js';
import type { ApiResponse } from '@/core/http/response/api-response.js';
import type { MessageDraftRecord } from '@/modules/messages/logic/entities/message-draft-record.js';
import type { DraftService } from '@/modules/messages/logic/draft.service.js';
import { MESSAGES_TYPES } from '@/modules/messages/messages.types.js';
import { chatParamsSchema, saveDraftSchema } from '@/modules/messages/web/dto/message.schemas.js';

/** Request-scoped handlers for the caller's private unsent drafts. */
@injectable()
export class DraftController {
  constructor(
    @inject(MESSAGES_TYPES.DraftService) private readonly drafts: DraftService,
    @inject(CORE_TYPES.ApiResponse) private readonly response: ApiResponse,
  ) {}

  save: RequestHandler = async (req, res) => {
    const user = this.requireUser(req);
    const { chatId } = chatParamsSchema.parse(req.params);
    const { body } = saveDraftSchema.parse(req.body);
    const draft = await this.drafts.save(chatId, user.id, body);

    this.response.ok(res, this.present(draft));
  };

  get: RequestHandler = async (req, res) => {
    const user = this.requireUser(req);
    const { chatId } = chatParamsSchema.parse(req.params);
    const draft = await this.drafts.get(chatId, user.id);

    this.response.ok(res, draft === null ? null : this.present(draft));
  };

  remove: RequestHandler = async (req, res) => {
    const user = this.requireUser(req);
    const { chatId } = chatParamsSchema.parse(req.params);
    await this.drafts.delete(chatId, user.id);

    this.response.noContent(res);
  };

  private present(draft: MessageDraftRecord) {
    return {
      body: draft.body,
      updatedAt: draft.updatedAt.toISOString(),
    };
  }

  private requireUser(req: Request): Express.User {
    if (!req.isAuthenticated()) {
      throw new UnauthorizedException();
    }

    return req.user;
  }
}
