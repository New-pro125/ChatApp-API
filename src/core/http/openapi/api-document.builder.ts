import { inject, injectable } from 'inversify';
import {
  createDocument,
  type ZodObjectInput,
  type ZodOpenApiOperationObject,
  type ZodOpenApiParameters,
  type ZodOpenApiPathsObject,
  type ZodOpenApiResponsesObject,
} from 'zod-openapi';
import type { AppConfig } from '@/core/config/app.config.js';
import { CORE_TYPES } from '@/core/container/core.types.js';
import type { OpenApiRegistry } from '@/core/http/openapi/openapi.registry.js';
import type { RegisteredOperation } from '@/core/http/openapi/openapi.types.js';

const HTTP_STATUS_PATTERN = /^[1-5]\d{2}$/;

export type OpenApiDocument = ReturnType<typeof createDocument>;

/**
 * Builds the OpenAPI 3.1 document from the operations registered by module
 * routers. The document is built once and cached; docs are static per build.
 */
@injectable()
export class ApiDocumentBuilder {
  private cached: OpenApiDocument | null = null;

  constructor(
    @inject(CORE_TYPES.OpenApiRegistry) private readonly registry: OpenApiRegistry,
    @inject(CORE_TYPES.Config) private readonly config: AppConfig,
  ) {}

  document(): OpenApiDocument {
    this.cached ??= this.create();
    return this.cached;
  }

  private create(): OpenApiDocument {
    const paths: ZodOpenApiPathsObject = {};

    for (const operation of this.registry.all()) {
      const item = paths[operation.path];
      const pathItem = item ?? {};

      if (item === undefined) {
        paths[operation.path] = pathItem;
      }

      pathItem[operation.method] = this.toOperation(operation);
    }

    return createDocument({
      openapi: '3.1.0',
      info: {
        title: 'Inversify Messenger API',
        version: '1.0.0',
        description:
          'Authentication and messenger API. Responses use a single success/error envelope.',
      },
      servers: [{ url: '/', description: 'Current host' }],
      tags: [
        { name: 'Health', description: 'Liveness and readiness probes' },
        { name: 'Auth', description: 'Registration, login, logout, and sessions' },
        { name: 'MFA', description: 'TOTP multi-factor authentication' },
        { name: 'Password', description: 'Password reset via email OTP' },
        { name: 'OAuth', description: 'Third-party and SSO authentication' },
      ],
      components: {
        securitySchemes: {
          sessionCookie: {
            type: 'apiKey',
            in: 'cookie',
            name: this.config.sessionCookieName,
            description: 'Server-side session cookie issued on login or registration.',
          },
        },
      },
      paths,
    });
  }

  private toOperation(operation: RegisteredOperation): ZodOpenApiOperationObject {
    const { contract } = operation;
    const requestParams: ZodOpenApiParameters = {};

    if (contract.request?.params !== undefined) {
      requestParams.path = contract.request.params as ZodObjectInput;
    }

    if (contract.request?.query !== undefined) {
      requestParams.query = contract.request.query as ZodObjectInput;
    }

    const security = contract.security?.map((requirement) =>
      Object.fromEntries(Object.entries(requirement).map(([name, scopes]) => [name, [...scopes]])),
    );

    const responses: ZodOpenApiResponsesObject = {};

    for (const [status, response] of Object.entries(contract.responses)) {
      if (!HTTP_STATUS_PATTERN.test(status)) {
        throw new Error(
          `Invalid response status "${status}" for operation ${contract.operationId}`,
        );
      }

      responses[status as `${1 | 2 | 3 | 4 | 5}${string}`] = {
        description: response.description,
        ...(response.schema === undefined
          ? {}
          : { content: { 'application/json': { schema: response.schema } } }),
      };
    }

    return {
      operationId: contract.operationId,
      tags: [...contract.tags],
      summary: contract.summary,
      ...(contract.description === undefined ? {} : { description: contract.description }),
      ...(contract.deprecated === undefined ? {} : { deprecated: contract.deprecated }),
      ...(security === undefined ? {} : { security }),
      ...(Object.keys(requestParams).length === 0 ? {} : { requestParams }),
      ...(contract.request?.body === undefined
        ? {}
        : {
            requestBody: {
              required: true,
              content: { 'application/json': { schema: contract.request.body } },
            },
          }),
      responses,
    };
  }
}
