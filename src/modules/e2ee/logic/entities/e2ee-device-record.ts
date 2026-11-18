export class E2eeDeviceRecord {
  constructor(
    readonly deviceId: string,
    readonly userId: string,
    readonly signingPublicKey: string,
    readonly identityPublicKey: string,
    readonly identitySignature: string,
    readonly signedPrekeyId: number,
    readonly signedPrekeyPublicKey: string,
    readonly signedPrekeySignature: string,
    readonly createdAt: Date,
    readonly updatedAt: Date,
    readonly rotatedAt: Date | null,
  ) {}
}
