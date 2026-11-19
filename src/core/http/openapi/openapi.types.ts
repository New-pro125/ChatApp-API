import type { ZodType } from 'zod';

export type OpenApiHttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

export interface OpenApiRequestContract {
  params?: ZodType;
  query?: ZodType;
  body?: ZodType;
  contentType?: 'application/json' | 'multipart/form-data';
}

export interface OpenApiResponseContract {
  description: string;
  schema?: ZodType;
}

export type OpenApiSecurityRequirement = Readonly<Record<string, readonly string[]>>;

/**
 * Documentation contract for one HTTP operation.
 *
 * The same Zod schemas used for request documentation are the schemas the
 * controllers validate with, so documentation cannot drift from validation.
 */
export interface RouteContract {
  operationId: string;
  tags: readonly string[];
  summary: string;
  description?: string;
  request?: OpenApiRequestContract;
  responses: Readonly<Record<number, OpenApiResponseContract>>;
  security?: readonly OpenApiSecurityRequirement[];
  deprecated?: boolean;
}

export interface RegisteredOperation {
  method: OpenApiHttpMethod;
  path: string;
  contract: RouteContract;
}
