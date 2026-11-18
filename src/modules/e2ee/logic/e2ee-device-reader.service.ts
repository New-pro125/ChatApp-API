import { inject, injectable } from 'inversify';
import type { E2eeDeviceReader, E2eeDeviceSummary } from '@/core/e2ee/e2ee-device.reader.js';
import { E2EE_TYPES } from '@/modules/e2ee/e2ee.types.js';
import type { E2eeRegistryRepository } from '@/modules/e2ee/logic/ports/e2ee-registry.repository.js';

/** Publishes only public device facts to other modules. */
@injectable()
export class E2eeDeviceReaderService implements E2eeDeviceReader {
  constructor(
    @inject(E2EE_TYPES.E2eeRegistryRepository)
    private readonly registry: E2eeRegistryRepository,
  ) {}

  async findByUserAndDevice(userId: string, deviceId: string): Promise<E2eeDeviceSummary | null> {
    const device = await this.registry.findByUserAndDevice(userId, deviceId);

    if (!device) {
      return null;
    }

    return {
      deviceId: device.deviceId,
      userId: device.userId,
      identityPublicKey: device.identityPublicKey,
      signingPublicKey: device.signingPublicKey,
      hasOneTimePreKeys: (await this.registry.countOneTimePrekeys(deviceId)) > 0,
    };
  }

  async hasAnyDevice(userId: string): Promise<boolean> {
    return (await this.registry.listByUser(userId)).length > 0;
  }
}
