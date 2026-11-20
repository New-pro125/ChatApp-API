import type { Request, RequestHandler } from 'express';
import { inject, injectable } from 'inversify';
import { CORE_TYPES } from '@/core/container/core.types.js';
import { NotFoundException, UnauthorizedException } from '@/core/errors/http.error.js';
import type { ApiResponse } from '@/core/http/response/api-response.js';
import type { UserSummaryReader } from '@/core/users/user-summary.reader.js';
import type { MentionService } from '@/modules/messages/logic/mention.service.js';
import { MESSAGES_TYPES } from '@/modules/messages/messages.types.js';
import {
  listMentionsQuerySchema,
  mentionParamsSchema,
  readMentionsSchema,
} from '@/modules/messages/web/dto/message.schemas.js';

/** Request-scoped handlers for the caller's mention inbox. */
@injectable()
export class MentionController {
  constructor(
    @inject(MESSAGES_TYPES.MentionService) private readonly mentions: MentionService,
    @inject(CORE_TYPES.UserSummaryReader) private readonly users: UserSummaryReader,
    @inject(CORE_TYPES.ApiResponse) private readonly response: ApiResponse,
  ) {}

  list: RequestHandler = async (req, res) => {
    const userId = this.requireUser(req).id;
    const query = listMentionsQuerySchema.parse(req.query);
    const [records, unreadCount] = await Promise.all([
      this.mentions.list(userId, { limit: query.limit + 1, beforeId: query.cursor }),
      this.mentions.countUnread(userId),
    ]);
    const page = records.slice(0, query.limit);
    const nextCursor = records.length > query.limit ? (page.at(-1)?.id ?? null) : null;
    const summaries = await this.users.findSummaries([
      ...new Set(page.map((record) => record.mentionedByUserId)),
    ]);
    const byId = new Map(summaries.map((summary) => [summary.id, summary]));

    const items = page.map((record) => {
      const summary = byId.get(record.mentionedByUserId);

      if (!summary) {
        throw new NotFoundException('Mention sender not found');
      }

      return {
        id: record.id,
        chatId: record.chatId,
        messageId: record.messageId,
        createdAt: record.createdAt.toISOString(),
        readAt: record.readAt?.toISOString() ?? null,
        mentionedBy: {
          userId: summary.id,
          username: summary.username,
          displayName: summary.displayName,
          avatarKey: summary.avatarKey,
        },
      };
    });

    this.response.ok(res, { unreadCount, mentions: items }, { pagination: { nextCursor } });
  };

  readOne: RequestHandler = async (req, res) => {
    const userId = this.requireUser(req).id;
    const { mentionId } = mentionParamsSchema.parse(req.params);
    const record = await this.mentions.markOne(userId, mentionId);

    this.response.ok(res, {
      id: record.id,
      readAt: (record.readAt ?? new Date()).toISOString(),
    });
  };

  readMany: RequestHandler = async (req, res) => {
    const userId = this.requireUser(req).id;
    const { mentionIds } = readMentionsSchema.parse(req.body);

    this.response.ok(res, { marked: await this.mentions.markMany(userId, mentionIds) });
  };

  private requireUser(req: Request): Express.User {
    if (!(req.auth && req.isAuthenticated())) {
      throw new UnauthorizedException();
    }

    return req.user;
  }
}
