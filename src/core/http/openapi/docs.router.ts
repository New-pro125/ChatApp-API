import { apiReference } from '@scalar/express-api-reference';
import { type RequestHandler, Router } from 'express';
import { inject, injectable } from 'inversify';
import { CORE_TYPES } from '@/core/container/core.types.js';
import type { ApiDocumentBuilder } from '@/core/http/openapi/api-document.builder.js';

/**
 * Serves the generated OpenAPI document and the Scalar reference UI.
 *
 * These endpoints intentionally bypass `ApiResponse`: the document must be a
 * raw OpenAPI object for Scalar and client generators to consume.
 */
@injectable()
export class DocsRouter {
  readonly router: Router = Router();

  constructor(
    @inject(CORE_TYPES.ApiDocumentBuilder) private readonly documents: ApiDocumentBuilder,
  ) {
    const documentHandler: RequestHandler = (_req, res) => {
      res.json(this.documents.document());
    };

    this.router.get('/openapi.json', documentHandler);
    this.router.get(
      '/docs',
      apiReference({
        url: '/api/openapi.json',
        theme: 'default',
        pageTitle: 'Inversify Messenger API',
      }),
    );
  }
}
