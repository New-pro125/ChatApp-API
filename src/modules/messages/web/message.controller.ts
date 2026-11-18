import type { Request, RequestHandler } from 'express';
import { inject, injectable } from 'inversify';
import { CORE_TYPES } from '@/core/container/core.types.js';
import { UnauthorizedException } from '@/core/errors/http.error.js';
import type { ApiResponse } from '@/core/http/response/api-response.js';
import type { MessageRecord } from '@/modules/messages/logic/entities/message-record.js';
import type { MessageService } from '@/modules/messages/logic/message.service.js';
import { MESSAGES_TYPES } from '@/modules/messages/messages.types.js';
import {
  chatParamsSchema,
  editMessageSchema,
  forwardMessageSchema,
  listMessagesQuerySchema,
  messageParamsSchema,
  sendMessageSchema,
} from '@/modules/messages/web/dto/message.schemas.js';

@injectable()
export class MessageController {
  constructor(
    @inject(MESSAGES_TYPES.MessageService) private readonly messages: MessageService,
    @inject(CORE_TYPES.ApiResponse) private readonly response: ApiResponse,
  ) {}

  send: RequestHandler = async (req, res) => {
    const user = this.requireUser(req);
    const { chatId } = chatParamsSchema.parse(req.params);
    const input = sendMessageSchema.parse(req.body);
    const message = await this.messages.send(user.id, chatId, input);

    this.response.created(res, this.present(message));
  };

  list: RequestHandler = async (req, res) => {
    const user = this.requireUser(req);
    const { chatId } = chatParamsSchema.parse(req.params);
    const query = listMessagesQuerySchema.parse(req.query);

    // Fetch one extra row so the cursor is null only when the page is truly
    // the last one, without running a separate count query.
    const rows = await this.messages.list(user.id, chatId, {
      limit: query.limit + 1,
      beforeId: query.cursor,
    });
    const page = rows.slice(0, query.limit);
    const nextCursor = rows.length > query.limit ? (page.at(-1)?.id ?? null) : null;

    this.response.cursor(
      res,
      page.map((message) => this.present(message)),
      nextCursor,
    );
  };

  edit: RequestHandler = async (req, res) => {
    const user = this.requireUser(req);
    const { chatId, messageId } = messageParamsSchema.parse(req.params);
    const { body } = editMessageSchema.parse(req.body);
    const message = await this.messages.edit(user.id, chatId, messageId, body);

    this.response.ok(res, this.present(message));
  };

  remove: RequestHandler = async (req, res) => {
    const user = this.requireUser(req);
    const { chatId, messageId } = messageParamsSchema.parse(req.params);

    await this.messages.remove(user.id, chatId, messageId);

    this.response.noContent(res);
  };

  forward: RequestHandler = async (req, res) => {
    const user = this.requireUser(req);
    const { chatId, messageId } = messageParamsSchema.parse(req.params);
    const { targetChatId } = forwardMessageSchema.parse(req.body);
    const message = await this.messages.forward(user.id, chatId, messageId, targetChatId);

    this.response.created(res, this.present(message));
  };

  private requireUser(req: Request): Express.User {
    if (!req.isAuthenticated()) {
      throw new UnauthorizedException();
    }

    return req.user;
  }

  /** Redacts soft-deleted bodies into tombstones at the HTTP boundary. */
  private present(message: MessageRecord) {
    return {
      id: message.id,
      chatId: message.chatId,
      senderId: message.senderId,
      type: message.type,
      body: message.deletedAt === null ? message.body : null,
      replyToMessageId: message.replyToMessageId,
      forwardedFromChatId: message.forwardedFromChatId,
      forwardedFromMessageId: message.forwardedFromMessageId,
      editedAt: message.editedAt?.toISOString() ?? null,
      deletedAt: message.deletedAt?.toISOString() ?? null,
      createdAt: message.createdAt.toISOString(),
    };
  }
}
