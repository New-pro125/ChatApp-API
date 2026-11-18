import { describe, expect, it } from 'vitest';
import { E2eeDeviceConflictException } from '@/core/errors/domain.error.js';
import { PostgresE2eeRegistryRepository } from '@/modules/e2ee/data/postgres-e2ee-registry.repository.js';
import { AuthFixture } from '../../fixtures/auth.fixture.js';
import { TestApp } from '../../helpers/test-app.js';

const registration = {
  userId: '00000000-0000-7000-8000-000000000001',
  deviceId: '00000000-0000-7000-8000-0000000000d1',
  signingPublicKey: 'A'.repeat(43),
  identityPublicKey: 'B'.repeat(43),
  identitySignature: 'C'.repeat(86),
  signedPrekeyId: 1,
  signedPrekeyPublicKey: 'D'.repeat(43),
  signedPrekeySignature: 'E'.repeat(86),
  oneTimePrekeys: [{ id: 1, publicKey: 'F'.repeat(43) }],
};

describe('PostgresE2eeRegistryRepository', () => {
  it('registers devices, consumes prekeys once, and rejects duplicates', async () => {
    const app = await TestApp.create();

    try {
      await app.clearDatabase();

      const auth = new AuthFixture(app);
      const user = await auth.createUser({ displayName: 'E2EE User' });
      const repository = new PostgresE2eeRegistryRepository(app.db);
      const input = { ...registration, userId: user.id };

      const device = await repository.create(input);
      expect(device.deviceId).toBe(input.deviceId);

      await expect(repository.create(input)).rejects.toBeInstanceOf(E2eeDeviceConflictException);

      const first = await repository.consumeOneTimePrekey(input.deviceId);
      const second = await repository.consumeOneTimePrekey(input.deviceId);

      expect(first?.prekeyId).toBe(1);
      expect(second).toBeNull();
    } finally {
      await app.close();
    }
  });
});
