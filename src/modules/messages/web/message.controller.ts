import type { Request, RequestHandler } from 'express';
import { inject, injectable } from 'inversify';
import type { AppConfig } from '@/core/config/app.config.js';
import { CORE_TYPES } from '@/core/container/core.types.js';
import { UnauthorizedException } from '@/core/errors/http.error.js';
import type { ApiResponse } from '@/core/http/response/api-response.js';
import type { MessageRecord } from '@/modules/messages/logic/entities/message-record.js';
import type { MessageService } from '@/modules/messages/logic/message.service.js';
import type { ReadReceiptService } from '@/modules/messages/logic/read-receipt.service.js';
import { MESSAGES_TYPES } from '@/modules/messages/messages.types.js';
import {
  chatParamsSchema,
  editMessageSchema,
  forwardMessageSchema,
  listMessagesQuerySchema,
  messageParamsSchema,
  sendMediaMessageSchema,
  sendMessageSchema,
  sendSecretMessageSchema,
} from '@/modules/messages/web/dto/message.schemas.js';
import type { MessagePresenter } from '@/modules/messages/web/message-presenter.service.js';
import type { MultipartMediaParser } from '@/modules/messages/web/multipart-media.parser.js';

@injectable()
export class MessageController {
  constructor(
    @inject(MESSAGES_TYPES.MessageService) private readonly messages: MessageService,
    @inject(MESSAGES_TYPES.ReadReceiptService) private readonly receipts: ReadReceiptService,
    @inject(MESSAGES_TYPES.MessagePresenter) private readonly presenter: MessagePresenter,
    @inject(CORE_TYPES.ApiResponse) private readonly response: ApiResponse,
    @inject(MESSAGES_TYPES.MultipartMediaParser) private readonly parser: MultipartMediaParser,
    @inject(CORE_TYPES.Config) private readonly config: AppConfig,
  ) {}

  send: RequestHandler = async (req, res) => {
    const { userId } = this.requireAuth(req);
    const { chatId } = chatParamsSchema.parse(req.params);
    const input = sendMessageSchema.parse(req.body);
    const message = await this.messages.send(userId, chatId, input);

    this.response.created(res, await this.present(message, userId));
  };

  sendMedia: RequestHandler = async (req, res) => {
    const { userId } = this.requireAuth(req);
    const { chatId } = chatParamsSchema.parse(req.params);
    const input = sendMediaMessageSchema.parse(req.body);
    const message = await this.messages.sendMedia(userId, chatId, input);

    this.response.created(res, await this.present(message, userId));
  };

  uploadMedia: RequestHandler = async (req, res) => {
    const { userId } = this.requireAuth(req);
    const { chatId } = chatParamsSchema.parse(req.params);
    const upload = await this.parser.parse(req, this.config.media.maxBytes);
    const message = await this.messages.sendMediaFromUpload(userId, chatId, {
      kind: upload.fields.kind,
      caption: upload.fields.caption,
      durationMs: upload.fields.durationMs,
      width: upload.fields.width,
      height: upload.fields.height,
      replyToMessageId: upload.fields.replyToMessageId,
      contentType: upload.contentType,
      sizeBytes: upload.sizeBytes,
      body: upload.body,
      assertComplete: upload.assertComplete,
    });

    this.response.created(res, await this.present(message, userId));
  };

  sendSecret: RequestHandler = async (req, res) => {
    const { userId, deviceId } = this.requireAuth(req);
    const { chatId } = chatParamsSchema.parse(req.params);
    const input = sendSecretMessageSchema.parse(req.body);
    const message = await this.messages.sendSecret(userId, deviceId, chatId, input);

    this.response.created(res, await this.present(message, userId));
  };

  list: RequestHandler = async (req, res) => {
    const { userId } = this.requireAuth(req);
    const { chatId } = chatParamsSchema.parse(req.params);
    const query = listMessagesQuerySchema.parse(req.query);

    // Fetch one extra row so the cursor is null only when the page is truly
    // the last one, without running a separate count query.
    const rows = await this.messages.list(userId, chatId, {
      limit: query.limit + 1,
      beforeId: query.cursor,
    });
    const receipts = await this.receipts.contextFor(chatId, userId);
    const page = rows.slice(0, query.limit);
    const nextCursor = rows.length > query.limit ? (page.at(-1)?.id ?? null) : null;

    this.response.cursor(
      res,
      await Promise.all(page.map((message) => this.presenter.present(message, receipts))),
      nextCursor,
    );
  };

  edit: RequestHandler = async (req, res) => {
    const { userId } = this.requireAuth(req);
    const { chatId, messageId } = messageParamsSchema.parse(req.params);
    const { body } = editMessageSchema.parse(req.body);
    const message = await this.messages.edit(userId, chatId, messageId, body);

    this.response.ok(res, await this.present(message, userId));
  };

  remove: RequestHandler = async (req, res) => {
    const { userId } = this.requireAuth(req);
    const { chatId, messageId } = messageParamsSchema.parse(req.params);

    await this.messages.remove(userId, chatId, messageId);

    this.response.noContent(res);
  };

  forward: RequestHandler = async (req, res) => {
    const { userId } = this.requireAuth(req);
    const { chatId, messageId } = messageParamsSchema.parse(req.params);
    const { targetChatId } = forwardMessageSchema.parse(req.body);
    const message = await this.messages.forward(userId, chatId, messageId, targetChatId);

    this.response.created(res, await this.present(message, userId));
  };

  private async present(message: MessageRecord, userId: string): Promise<Record<string, unknown>> {
    const context = await this.receipts.contextFor(message.chatId, userId);

    return this.presenter.present(message, context);
  }

  private requireAuth(req: Request): { userId: string; deviceId: string } {
    if (!(req.auth && req.isAuthenticated())) {
      throw new UnauthorizedException();
    }

    return { userId: req.user.id, deviceId: req.auth.deviceId };
  }
}
