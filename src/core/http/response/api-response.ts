import type { Response } from 'express';
import { injectable } from 'inversify';
import type { ErrorCode } from '@/core/errors/error-code.js';

/**
 * Pagination metadata. Page-based fields describe an offset page; `nextCursor`
 * is set by keyset endpoints and is opaque to the client.
 */
export interface PaginationMeta {
  page?: number;
  pageSize?: number;
  total?: number;
  totalPages?: number;
  hasNextPage?: boolean;
  hasPreviousPage?: boolean;
  nextCursor?: string | null;
}

export interface ResponseMeta {
  requestId: string;
  pagination?: PaginationMeta;
}

export interface ApiSuccessResponse<T> {
  success: true;
  data: T;
  message?: string;
  meta: ResponseMeta;
}

export interface ApiErrorBody {
  code: ErrorCode;
  message: string;
  details?: unknown;
}

export interface ApiErrorResponse {
  success: false;
  error: ApiErrorBody;
  meta: {
    requestId: string;
  };
}

export interface PaginationInput {
  page: number;
  pageSize: number;
  total: number;
}

export interface SuccessOptions {
  message?: string;
  pagination?: PaginationMeta;
}

export interface PaginatedOptions {
  message?: string;
}

/**
 * Builds every HTTP response body.
 *
 * Success: `{ success: true, data, message?, meta: { requestId, pagination? } }`
 * Error:   `{ success: false, error: { code, message, details? }, meta: { requestId } }`
 */
@injectable()
export class ApiResponse {
  send<T>(res: Response, status: number, data: T, options: SuccessOptions = {}): Response {
    const body: ApiSuccessResponse<T> = {
      success: true,
      data,
      ...(options.message === undefined ? {} : { message: options.message }),
      meta: {
        requestId: res.req.requestId,
        ...(options.pagination === undefined ? {} : { pagination: options.pagination }),
      },
    };

    return res.status(status).json(body);
  }

  ok<T>(res: Response, data: T, options: SuccessOptions = {}): Response {
    return this.send(res, 200, data, options);
  }

  created<T>(res: Response, data: T, options: SuccessOptions = {}): Response {
    return this.send(res, 201, data, options);
  }

  accepted<T>(res: Response, data: T, options: SuccessOptions = {}): Response {
    return this.send(res, 202, data, options);
  }

  list<T>(res: Response, items: T[], options: SuccessOptions = {}): Response {
    return this.ok(res, items, options);
  }

  paginated<T>(
    res: Response,
    items: T[],
    pagination: PaginationInput,
    options: PaginatedOptions = {},
  ): Response {
    return this.ok(res, items, {
      ...(options.message === undefined ? {} : { message: options.message }),
      pagination: this.createPaginationMeta(pagination),
    });
  }

  /** Sends a keyset page with an opaque `nextCursor` (null on the last page). */
  cursor<T>(
    res: Response,
    items: T[],
    nextCursor: string | null,
    options: SuccessOptions = {},
  ): Response {
    return this.ok(res, items, {
      ...(options.message === undefined ? {} : { message: options.message }),
      pagination: { nextCursor },
    });
  }

  noContent(res: Response): Response {
    return res.status(204).end();
  }

  fail(res: Response, status: number, error: ApiErrorBody): Response {
    const body: ApiErrorResponse = {
      success: false,
      error,
      meta: {
        requestId: res.req.requestId,
      },
    };

    return res.status(status).json(body);
  }

  private createPaginationMeta(input: PaginationInput): PaginationMeta {
    const totalPages = input.pageSize > 0 ? Math.ceil(input.total / input.pageSize) : 0;

    return {
      page: input.page,
      pageSize: input.pageSize,
      total: input.total,
      totalPages,
      hasNextPage: input.page < totalPages,
      hasPreviousPage: input.page > 1,
    };
  }
}
