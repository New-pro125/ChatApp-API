/// <reference types="zod-openapi" />
import { z } from 'zod';
import {
  commonErrorResponses,
  noContentResponse,
  successEnvelope,
} from '@/core/http/openapi/openapi.schemas.js';
import type { RouteContract } from '@/core/http/openapi/openapi.types.js';
import {
  createStorySchema,
  storyParamsSchema,
  userStoriesParamsSchema,
} from '@/modules/stories/web/dto/story.schemas.js';

const bearerSecurity = [{ bearerAuth: [] }] as const;

export const storySchema = z
  .object({
    id: z.uuid(),
    caption: z.string().nullable(),
    mediaKey: z.string().nullable(),
    expiresAt: z.iso.datetime(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'Story' });

const storyResponse = successEnvelope(storySchema, 'StoryResponse');
const storyListResponse = successEnvelope(z.array(storySchema), 'StoryListResponse');

/**
 * OpenAPI contracts for the stories module.
 *
 * Each request schema is the same Zod schema the controller parses, so the
 * documentation and validation cannot drift apart.
 */
export const storyContracts = {
  create: {
    operationId: 'stories.create',
    tags: ['Stories'],
    summary: 'Create a story',
    description:
      'Creates an ephemeral story with a caption, a media key, or both. The expiry is derived from STORY_TTL_SECONDS. The media key is supplied by the client until the media pipeline exists.',
    security: bearerSecurity,
    request: { body: createStorySchema },
    responses: {
      201: { description: 'Story created', schema: storyResponse },
      ...commonErrorResponses,
    },
  },
  listMine: {
    operationId: 'stories.listMine',
    tags: ['Stories'],
    summary: 'List the caller active stories',
    description: 'Returns the authenticated user active stories, newest first.',
    security: bearerSecurity,
    responses: {
      200: { description: 'Active stories, newest first', schema: storyListResponse },
      ...commonErrorResponses,
    },
  },
  listUser: {
    operationId: 'stories.listUser',
    tags: ['Stories'],
    summary: "List another user's active stories",
    description:
      'Honors the owner storiesVisibility setting. When the stories are hidden the response is an empty list rather than a 403, so the setting is not leaked.',
    security: bearerSecurity,
    request: { params: userStoriesParamsSchema },
    responses: {
      200: { description: 'Active stories, newest first', schema: storyListResponse },
      ...commonErrorResponses,
    },
  },
  delete: {
    operationId: 'stories.delete',
    tags: ['Stories'],
    summary: 'Delete an owned story',
    description: 'Returns 404 when the story does not exist or is not owned by the caller.',
    security: bearerSecurity,
    request: { params: storyParamsSchema },
    responses: {
      204: noContentResponse,
      ...commonErrorResponses,
    },
  },
} satisfies Record<string, RouteContract>;
