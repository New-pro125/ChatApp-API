import type { Request, RequestHandler } from 'express';
import { inject, injectable } from 'inversify';
import { CORE_TYPES } from '@/core/container/core.types.js';
import { UnauthorizedException } from '@/core/errors/http.error.js';
import type { ApiResponse } from '@/core/http/response/api-response.js';
import type { ChatService } from '@/modules/messages/logic/chat.service.js';
import type { ChatView } from '@/modules/messages/logic/entities/chat-view.js';
import type { ReadReceiptService } from '@/modules/messages/logic/read-receipt.service.js';
import { MESSAGES_TYPES } from '@/modules/messages/messages.types.js';
import {
  chatParamsSchema,
  markReadSchema,
  openDirectChatSchema,
  setSelfDestructSchema,
} from '@/modules/messages/web/dto/message.schemas.js';

@injectable()
export class ChatController {
  constructor(
    @inject(MESSAGES_TYPES.ChatService) private readonly chats: ChatService,
    @inject(MESSAGES_TYPES.ReadReceiptService) private readonly receipts: ReadReceiptService,
    @inject(CORE_TYPES.ApiResponse) private readonly response: ApiResponse,
  ) {}

  openDirect: RequestHandler = async (req, res) => {
    const user = this.requireUser(req);
    const { participantId } = openDirectChatSchema.parse(req.body);
    const result = await this.chats.openDirect(user.id, participantId);
    const data = this.present(result.view);

    if (result.created) {
      this.response.created(res, data);
      return;
    }

    this.response.ok(res, data);
  };

  openSecret: RequestHandler = async (req, res) => {
    const user = this.requireUser(req);
    const { participantId } = openDirectChatSchema.parse(req.body);
    const result = await this.chats.openSecret(user.id, participantId);
    const data = this.present(result.view);

    if (result.created) {
      this.response.created(res, data);
      return;
    }

    this.response.ok(res, data);
  };

  listMine: RequestHandler = async (req, res) => {
    const user = this.requireUser(req);
    const chats = await this.chats.listForUser(user.id);

    this.response.list(
      res,
      chats.map((chat) => this.present(chat)),
    );
  };

  markRead: RequestHandler = async (req, res) => {
    const user = this.requireUser(req);
    const { chatId } = chatParamsSchema.parse(req.params);
    const { messageId } = markReadSchema.parse(req.body ?? {});
    const result = await this.receipts.markRead(user.id, chatId, messageId);

    this.response.ok(res, result);
  };

  setSelfDestruct: RequestHandler = async (req, res) => {
    const user = this.requireUser(req);
    const { chatId } = chatParamsSchema.parse(req.params);
    const { preset } = setSelfDestructSchema.parse(req.body);
    const updated = await this.chats.setSelfDestructPreset(user.id, chatId, preset);

    this.response.ok(res, { preset: updated });
  };

  private requireUser(req: Request): Express.User {
    if (!req.isAuthenticated()) {
      throw new UnauthorizedException();
    }

    return req.user;
  }

  private present(chat: ChatView) {
    return {
      id: chat.id,
      type: chat.type,
      title: chat.title,
      unreadCount: chat.unreadCount,
      selfDestructPreset: chat.selfDestructPreset,
      participants: chat.participants.map((participant) => ({
        userId: participant.id,
        username: participant.username,
        displayName: participant.displayName,
        avatarKey: participant.avatarKey,
      })),
      createdAt: chat.createdAt.toISOString(),
      updatedAt: chat.updatedAt.toISOString(),
    };
  }
}
