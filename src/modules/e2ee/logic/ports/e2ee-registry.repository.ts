import type { E2eeDeviceRecord } from '@/modules/e2ee/logic/entities/e2ee-device-record.js';
import type { E2eePrekeyRecord } from '@/modules/e2ee/logic/entities/e2ee-prekey-record.js';

export interface CreateE2eeDeviceInput {
  readonly deviceId: string;
  readonly userId: string;
  readonly signingPublicKey: string;
  readonly identityPublicKey: string;
  readonly identitySignature: string;
  readonly signedPrekeyId: number;
  readonly signedPrekeyPublicKey: string;
  readonly signedPrekeySignature: string;
  readonly oneTimePrekeys: ReadonlyArray<{ readonly id: number; readonly publicKey: string }>;
}

export interface E2eeRegistryRepository {
  create(input: CreateE2eeDeviceInput): Promise<E2eeDeviceRecord>;
  findByUserAndDevice(userId: string, deviceId: string): Promise<E2eeDeviceRecord | null>;
  findByDeviceId(deviceId: string): Promise<E2eeDeviceRecord | null>;
  listByUser(userId: string): Promise<E2eeDeviceRecord[]>;
  replace(input: CreateE2eeDeviceInput): Promise<E2eeDeviceRecord>;
  addOneTimePrekeys(
    deviceId: string,
    keys: ReadonlyArray<{ readonly id: number; readonly publicKey: string }>,
  ): Promise<void>;
  consumeOneTimePrekey(deviceId: string): Promise<E2eePrekeyRecord | null>;
  countOneTimePrekeys(deviceId: string): Promise<number>;
}
