import type { Request, RequestHandler } from 'express';
import { inject, injectable } from 'inversify';
import { CORE_TYPES } from '@/core/container/core.types.js';
import { UnauthorizedException } from '@/core/errors/http.error.js';
import type { ApiResponse } from '@/core/http/response/api-response.js';
import type { StoryService } from '@/modules/stories/logic/story.service.js';
import { STORIES_TYPES } from '@/modules/stories/stories.types.js';
import {
  createStorySchema,
  storyParamsSchema,
  userStoriesParamsSchema,
} from '@/modules/stories/web/dto/story.schemas.js';

@injectable()
export class StoryController {
  constructor(
    @inject(STORIES_TYPES.StoryService) private readonly stories: StoryService,
    @inject(CORE_TYPES.ApiResponse) private readonly response: ApiResponse,
  ) {}

  create: RequestHandler = async (req, res) => {
    const user = this.requireUser(req);
    const input = createStorySchema.parse(req.body);
    const story = await this.stories.create(user.id, {
      caption: input.caption ?? null,
      mediaKey: input.mediaKey ?? null,
    });

    this.response.created(res, story);
  };

  listMine: RequestHandler = async (req, res) => {
    const user = this.requireUser(req);
    const stories = await this.stories.listMine(user.id);

    this.response.list(res, stories);
  };

  listUser: RequestHandler = async (req, res) => {
    const user = this.requireUser(req);
    const { userId } = userStoriesParamsSchema.parse(req.params);
    const stories = await this.stories.listForViewer(userId, user.id);

    this.response.list(res, stories);
  };

  remove: RequestHandler = async (req, res) => {
    const user = this.requireUser(req);
    const { id } = storyParamsSchema.parse(req.params);

    await this.stories.remove(user.id, id);

    this.response.noContent(res);
  };

  private requireUser(req: Request): Express.User {
    if (!req.isAuthenticated()) {
      throw new UnauthorizedException();
    }

    return req.user;
  }
}
