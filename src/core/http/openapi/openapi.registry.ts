import { injectable } from 'inversify';
import type { RegisteredOperation } from '@/core/http/openapi/openapi.types.js';

/**
 * Collects documented operations from every module router.
 *
 * The registry rejects duplicate `operationId` values and duplicate
 * method/path pairs while the application boots, so contract drift fails fast
 * instead of producing an ambiguous OpenAPI document.
 */
@injectable()
export class OpenApiRegistry {
  private readonly operations: RegisteredOperation[] = [];
  private readonly operationIds = new Set<string>();
  private readonly routes = new Set<string>();

  register(operation: RegisteredOperation): void {
    const routeKey = `${operation.method.toUpperCase()} ${operation.path}`;

    if (this.routes.has(routeKey)) {
      throw new Error(`Duplicate documented route: ${routeKey}`);
    }

    if (this.operationIds.has(operation.contract.operationId)) {
      throw new Error(`Duplicate OpenAPI operationId: ${operation.contract.operationId}`);
    }

    this.routes.add(routeKey);
    this.operationIds.add(operation.contract.operationId);
    this.operations.push(operation);
  }

  all(): readonly RegisteredOperation[] {
    return this.operations;
  }
}
