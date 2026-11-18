import { inject, injectable } from 'inversify';
import {
  E2eeDeviceConflictException,
  E2eeDeviceNotFoundException,
  E2eePrekeyConflictException,
  E2eePrekeyExhaustedException,
} from '@/core/errors/domain.error.js';
import { UniqueConstraintException } from '@/core/errors/repository.error.js';
import { E2EE_TYPES } from '@/modules/e2ee/e2ee.types.js';
import type {
  E2eeKeyService,
  E2eeRegistrationInput,
} from '@/modules/e2ee/logic/e2ee-key.service.js';
import type { E2eeDeviceRecord } from '@/modules/e2ee/logic/entities/e2ee-device-record.js';
import type {
  CreateE2eeDeviceInput,
  E2eeRegistryRepository,
} from '@/modules/e2ee/logic/ports/e2ee-registry.repository.js';

export interface E2eeDeviceListing {
  readonly device: E2eeDeviceRecord;
  readonly hasOneTimePreKeys: boolean;
}

/** Coordinates public device-key registration with the E2EE registry. */
@injectable()
export class E2eeDeviceService {
  constructor(
    @inject(E2EE_TYPES.E2eeRegistryRepository)
    private readonly registry: E2eeRegistryRepository,
    @inject(E2EE_TYPES.E2eeKeyService) private readonly keys: E2eeKeyService,
  ) {}

  register(userId: string, deviceId: string, input: E2eeRegistrationInput) {
    this.keys.assertRegistrationInput(input);

    return this.translateConflicts(() =>
      this.registry.create(this.toRegistryInput(userId, deviceId, input)),
    );
  }

  async listForUser(userId: string): Promise<E2eeDeviceListing[]> {
    const devices = await this.registry.listByUser(userId);

    return Promise.all(
      devices.map(async (device) => ({
        device,
        hasOneTimePreKeys: (await this.registry.countOneTimePrekeys(device.deviceId)) > 0,
      })),
    );
  }

  async rotate(userId: string, deviceId: string, input: E2eeRegistrationInput) {
    this.keys.assertRegistrationInput(input);
    const existing = await this.registry.findByUserAndDevice(userId, deviceId);

    if (!existing) {
      throw new E2eeDeviceNotFoundException();
    }

    return this.translateConflicts(() =>
      this.registry.replace(this.toRegistryInput(userId, deviceId, input)),
    );
  }

  async addOneTimePrekeys(
    userId: string,
    deviceId: string,
    keys: ReadonlyArray<{ readonly id: number; readonly publicKey: string }>,
  ): Promise<void> {
    const existing = await this.registry.findByUserAndDevice(userId, deviceId);

    if (!existing) {
      throw new E2eeDeviceNotFoundException();
    }

    if (keys.length < 1 || keys.length > 100) {
      throw new E2eeDeviceConflictException('Provide between 1 and 100 one-time prekeys');
    }

    for (const key of keys) {
      this.keys.assertRegistrationInput({
        signingPublicKey: existing.signingPublicKey,
        identityPublicKey: existing.identityPublicKey,
        identitySignature: existing.identitySignature,
        signedPrekey: {
          id: existing.signedPrekeyId,
          publicKey: existing.signedPrekeyPublicKey,
          signature: existing.signedPrekeySignature,
        },
        oneTimePrekeys: [key],
      });
    }

    const added = await this.translateConflicts(() =>
      this.registry.addOneTimePrekeys(deviceId, keys),
    );

    if (!added) {
      throw new E2eeDeviceNotFoundException();
    }
  }

  async bundle(userId: string, deviceId: string) {
    const result = await this.registry.consumeBundle(userId, deviceId);

    if (!result) {
      throw new E2eeDeviceNotFoundException();
    }

    if (!result.oneTimePrekey) {
      throw new E2eePrekeyExhaustedException();
    }

    return { device: result.device, oneTimePrekey: result.oneTimePrekey };
  }

  private toRegistryInput(
    userId: string,
    deviceId: string,
    input: E2eeRegistrationInput,
  ): CreateE2eeDeviceInput {
    return {
      userId,
      deviceId,
      signingPublicKey: input.signingPublicKey,
      identityPublicKey: input.identityPublicKey,
      identitySignature: input.identitySignature,
      signedPrekeyId: input.signedPrekey.id,
      signedPrekeyPublicKey: input.signedPrekey.publicKey,
      signedPrekeySignature: input.signedPrekey.signature,
      oneTimePrekeys: input.oneTimePrekeys,
    };
  }

  private async translateConflicts<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof UniqueConstraintException) {
        if (error.constraint === 'e2ee_prekeys_pkey') {
          throw new E2eePrekeyConflictException();
        }

        throw new E2eeDeviceConflictException();
      }

      throw error;
    }
  }
}
