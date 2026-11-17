export const STORIES_TYPES = {
  StoryRepository: Symbol.for('Stories.StoryRepository'),
  StoryService: Symbol.for('Stories.StoryService'),

  StoryRateLimiter: Symbol.for('Stories.StoryRateLimiter'),
  StoryController: Symbol.for('Stories.StoryController'),
  StoryRouter: Symbol.for('Stories.StoryRouter'),
  RequestScope: Symbol.for('Stories.RequestScope'),
} as const;
