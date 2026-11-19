import type { Request, RequestHandler } from 'express';
import { inject, injectable } from 'inversify';
import { CORE_TYPES } from '@/core/container/core.types.js';
import { UnauthorizedException } from '@/core/errors/http.error.js';
import type { ApiResponse } from '@/core/http/response/api-response.js';
import type { PinService } from '@/modules/messages/logic/pin.service.js';
import type { ReadReceiptService } from '@/modules/messages/logic/read-receipt.service.js';
import { MESSAGES_TYPES } from '@/modules/messages/messages.types.js';
import {
  chatParamsSchema,
  messageParamsSchema,
} from '@/modules/messages/web/dto/message.schemas.js';
import type { MessagePresenter } from '@/modules/messages/web/message-presenter.service.js';

/** Request-scoped handlers for per-user message bookmarks. */
@injectable()
export class PinController {
  constructor(
    @inject(MESSAGES_TYPES.PinService) private readonly pins: PinService,
    @inject(MESSAGES_TYPES.ReadReceiptService) private readonly receipts: ReadReceiptService,
    @inject(MESSAGES_TYPES.MessagePresenter) private readonly presenter: MessagePresenter,
    @inject(CORE_TYPES.ApiResponse) private readonly response: ApiResponse,
  ) {}

  pin: RequestHandler = async (req, res) => {
    const { chatId, messageId } = messageParamsSchema.parse(req.params);
    const pin = await this.pins.pin(this.requireUser(req).id, chatId, messageId);

    this.response.created(res, pin);
  };

  unpin: RequestHandler = async (req, res) => {
    const { chatId, messageId } = messageParamsSchema.parse(req.params);
    await this.pins.unpin(this.requireUser(req).id, chatId, messageId);

    this.response.noContent(res);
  };

  list: RequestHandler = async (req, res) => {
    const userId = this.requireUser(req).id;
    const { chatId } = chatParamsSchema.parse(req.params);
    const pinned = await this.pins.list(userId, chatId);
    const receipts = await this.receipts.contextFor(chatId, userId);
    const pinnedAtById = new Map(pinned.map((item) => [item.message.id, item.pinnedAt]));
    const items = await Promise.all(
      pinned.map((item) => this.presenter.present(item.message, receipts, pinnedAtById)),
    );

    this.response.list(res, items);
  };

  private requireUser(req: Request): Express.User {
    if (!(req.auth && req.isAuthenticated())) {
      throw new UnauthorizedException();
    }

    return req.user;
  }
}
