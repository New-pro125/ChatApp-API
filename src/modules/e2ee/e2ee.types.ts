export const E2EE_TYPES = {
  RequestScope: Symbol.for('E2ee.RequestScope'),
  E2eeRateLimiter: Symbol.for('E2ee.E2eeRateLimiter'),
  E2eeRegistryRepository: Symbol.for('E2ee.E2eeRegistryRepository'),
  E2eeKeyService: Symbol.for('E2ee.E2eeKeyService'),
  E2eeDeviceService: Symbol.for('E2ee.E2eeDeviceService'),
  E2eeDeviceReader: Symbol.for('E2ee.E2eeDeviceReader'),
  E2eeController: Symbol.for('E2ee.E2eeController'),
  E2eeRouter: Symbol.for('E2ee.E2eeRouter'),
} as const;
