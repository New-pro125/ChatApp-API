export class E2eePrekeyRecord {
  constructor(
    readonly deviceId: string,
    readonly prekeyId: number,
    readonly publicKey: string,
    readonly createdAt: Date,
  ) {}
}
