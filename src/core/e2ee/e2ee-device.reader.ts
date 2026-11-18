export interface E2eeDeviceSummary {
  readonly deviceId: string;
  readonly userId: string;
  readonly identityPublicKey: string;
  readonly signingPublicKey: string;
  readonly hasOneTimePreKeys: boolean;
}

export interface E2eeDeviceReader {
  findByUserAndDevice(userId: string, deviceId: string): Promise<E2eeDeviceSummary | null>;
  hasAnyDevice(userId: string): Promise<boolean>;
}
