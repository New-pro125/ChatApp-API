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

/** A locked device snapshot and, when available, one consumed one-time prekey. */
export interface E2eeBundleRecord {
  readonly device: E2eeDeviceRecord;
  readonly oneTimePrekey: E2eePrekeyRecord | null;
}

export interface E2eeRegistryRepository {
  create(input: CreateE2eeDeviceInput): Promise<E2eeDeviceRecord>;
  findByUserAndDevice(userId: string, deviceId: string): Promise<E2eeDeviceRecord | null>;
  listByUser(userId: string): Promise<E2eeDeviceRecord[]>;
  replace(input: CreateE2eeDeviceInput): Promise<E2eeDeviceRecord>;
  addOneTimePrekeys(
    deviceId: string,
    keys: ReadonlyArray<{ readonly id: number; readonly publicKey: string }>,
  ): Promise<boolean>;
  /**
   * Locks the device row so rotation and replenishment serialize, then
   * consumes the oldest one-time prekey in the same transaction.
   *
   * Returns `null` when the device does not exist for the user. A non-null
   * result with a null prekey means the device has no one-time prekeys left.
   */
  consumeBundle(userId: string, deviceId: string): Promise<E2eeBundleRecord | null>;
  countOneTimePrekeys(deviceId: string): Promise<number>;
}
