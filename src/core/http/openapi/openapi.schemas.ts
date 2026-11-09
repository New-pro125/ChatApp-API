/// <reference types="zod-openapi" />
import { type ZodType, z } from 'zod';
import { ErrorCode } from '@/core/errors/error-code.js';
import type { OpenApiResponseContract } from '@/core/http/openapi/openapi.types.js';

const errorCodes = Object.values(ErrorCode) as [ErrorCode, ...ErrorCode[]];

export const paginationMetaSchema = z
  .object({
    page: z.number().int().min(1),
    pageSize: z.number().int().min(1),
    total: z.number().int().min(0),
    totalPages: z.number().int().min(0),
    hasNextPage: z.boolean(),
    hasPreviousPage: z.boolean(),
  })
  .meta({ id: 'PaginationMeta' });

export const responseMetaSchema = z
  .object({
    requestId: z.string(),
    pagination: paginationMetaSchema.optional(),
  })
  .meta({ id: 'ResponseMeta' });

export const apiErrorBodySchema = z
  .object({
    code: z.enum(errorCodes),
    message: z.string(),
    details: z.unknown().optional(),
  })
  .meta({ id: 'ApiErrorBody' });

export const apiErrorResponseSchema = z
  .object({
    success: z.literal(false),
    error: apiErrorBodySchema,
    meta: z.object({ requestId: z.string() }),
  })
  .meta({ id: 'ApiErrorResponse' });

/**
 * Wraps a resource schema in the standard success envelope.
 *
 * Pass `id` only when the same envelope is reused as a component; inline
 * envelopes keep the generated document smaller.
 */
export function successEnvelope<T extends ZodType>(data: T, id?: string): ZodType {
  const schema = z.object({
    success: z.literal(true),
    data,
    message: z.string().optional(),
    meta: responseMetaSchema,
  });

  return id === undefined ? schema : schema.meta({ id });
}

const errorResponse = (description: string): OpenApiResponseContract => ({
  description,
  schema: apiErrorResponseSchema,
});

/** Error responses shared by most authenticated JSON endpoints. */
export const commonErrorResponses = {
  400: errorResponse('Invalid request payload'),
  401: errorResponse('Authentication is required or credentials are invalid'),
  403: errorResponse('The authenticated user may not perform this action'),
  404: errorResponse('The requested resource does not exist'),
  423: errorResponse('The account is locked'),
  429: errorResponse('Too many requests'),
  500: errorResponse('Unexpected server error'),
} satisfies Record<number, OpenApiResponseContract>;

export const noContentResponse: OpenApiResponseContract = {
  description: 'No content',
};
