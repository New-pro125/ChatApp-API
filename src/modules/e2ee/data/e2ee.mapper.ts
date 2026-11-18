import { E2eeDeviceRecord } from '@/modules/e2ee/logic/entities/e2ee-device-record.js';
import { E2eePrekeyRecord } from '@/modules/e2ee/logic/entities/e2ee-prekey-record.js';

type DeviceRow = {
  deviceId: string;
  userId: string;
  signingPublicKey: string;
  identityPublicKey: string;
  identitySignature: string;
  signedPrekeyId: number;
  signedPrekeyPublicKey: string;
  signedPrekeySignature: string;
  createdAt: Date;
  updatedAt: Date;
  rotatedAt: Date | null;
};

type PrekeyRow = {
  deviceId: string;
  prekeyId: number;
  publicKey: string;
  createdAt: Date;
};

export class E2eeMapper {
  device(row: DeviceRow): E2eeDeviceRecord {
    return new E2eeDeviceRecord(
      row.deviceId,
      row.userId,
      row.signingPublicKey,
      row.identityPublicKey,
      row.identitySignature,
      row.signedPrekeyId,
      row.signedPrekeyPublicKey,
      row.signedPrekeySignature,
      row.createdAt,
      row.updatedAt,
      row.rotatedAt,
    );
  }

  prekey(row: PrekeyRow): E2eePrekeyRecord {
    return new E2eePrekeyRecord(row.deviceId, row.prekeyId, row.publicKey, row.createdAt);
  }
}
