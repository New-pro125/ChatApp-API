import { Container } from 'inversify';
import { CORE_TYPES } from '@/core/container/core.types.js';
import type { E2eeDeviceReader } from '@/core/e2ee/e2ee-device.reader.js';
import { E2eeRateLimiter } from '@/core/http/middleware/rate-limit.js';
import { RequestScopeMiddleware } from '@/core/http/middleware/request-scope.js';
import { PostgresE2eeRegistryRepository } from '@/modules/e2ee/data/postgres-e2ee-registry.repository.js';
import { E2EE_TYPES } from '@/modules/e2ee/e2ee.types.js';
import { E2eeDeviceService } from '@/modules/e2ee/logic/e2ee-device.service.js';
import { E2eeDeviceReaderService } from '@/modules/e2ee/logic/e2ee-device-reader.service.js';
import { E2eeKeyService } from '@/modules/e2ee/logic/e2ee-key.service.js';
import type { E2eeRegistryRepository } from '@/modules/e2ee/logic/ports/e2ee-registry.repository.js';
import { E2eeController } from '@/modules/e2ee/web/e2ee.controller.js';
import { E2eeRouter } from '@/modules/e2ee/web/routes/e2ee.router.js';

/** Child container for the E2EE module with a root-scoped device reader. */
export class E2eeContainer extends Container {
  constructor(private readonly root: Container) {
    super({ parent: root });

    this.bind<RequestScopeMiddleware>(E2EE_TYPES.RequestScope).toConstantValue(
      new RequestScopeMiddleware(this),
    );
    this.bind<E2eeRateLimiter>(E2EE_TYPES.E2eeRateLimiter).to(E2eeRateLimiter).inSingletonScope();
    this.bind<E2eeRegistryRepository>(E2EE_TYPES.E2eeRegistryRepository)
      .to(PostgresE2eeRegistryRepository)
      .inSingletonScope();
    this.bind<E2eeKeyService>(E2EE_TYPES.E2eeKeyService).to(E2eeKeyService).inSingletonScope();
    this.bind<E2eeDeviceService>(E2EE_TYPES.E2eeDeviceService)
      .to(E2eeDeviceService)
      .inSingletonScope();
    this.bind<E2eeDeviceReaderService>(E2EE_TYPES.E2eeDeviceReader)
      .to(E2eeDeviceReaderService)
      .inSingletonScope();
    this.bind<E2eeController>(E2EE_TYPES.E2eeController).to(E2eeController);
    this.bind<E2eeRouter>(E2EE_TYPES.E2eeRouter).to(E2eeRouter).inSingletonScope();

    this.root
      .bind<E2eeDeviceReader>(CORE_TYPES.E2eeDeviceReader)
      .toConstantValue(this.get<E2eeDeviceReaderService>(E2EE_TYPES.E2eeDeviceReader));
  }
}
