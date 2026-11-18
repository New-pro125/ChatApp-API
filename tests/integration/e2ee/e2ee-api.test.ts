import { describe, expect, it } from 'vitest';
import { CORE_TYPES } from '@/core/container/core.types.js';
import { makeE2eeRegistration } from '../../helpers/e2ee-keys.js';
import { TestApp } from '../../helpers/test-app.js';
import { MessagingApiFixture } from '../messages/messaging-api.fixture.js';

describe('/api/e2ee', () => {
  it('registers, lists, rotates, replenishes, consumes bundles, and rejects missing devices', async () => {
    const app = await TestApp.create();
    const fixture = new MessagingApiFixture(app);

    try {
      expect(app.container.isBound(CORE_TYPES.E2eeDeviceReader)).toBe(true);

      await app.clearDatabase();
      const user = await fixture.verifiedUser('E2EE API User');

      const created = await app.request
        .post('/api/e2ee/devices')
        .set(user.headers)
        .send(makeE2eeRegistration(2));
      expect(created.status).toBe(201);
      expect(created.body.data.identityPublicKey).toBeTypeOf('string');

      const deviceId = created.body.data.deviceId as string;
      const bundlePath = `/api/e2ee/users/${user.id}/devices/${deviceId}/bundle`;

      const duplicate = await app.request
        .post('/api/e2ee/devices')
        .set(user.headers)
        .send(makeE2eeRegistration(1));
      expect(duplicate.status).toBe(409);
      expect(duplicate.body.error.code).toBe('E2EE_DEVICE_CONFLICT');

      const listed = await app.request.get('/api/e2ee/devices').set(user.headers);
      expect(listed.status).toBe(200);
      expect(listed.body.data).toHaveLength(1);

      const rotated = await app.request
        .post('/api/e2ee/devices/rotate')
        .set(user.headers)
        .send(makeE2eeRegistration(2));
      expect(rotated.status).toBe(200);
      expect(rotated.body.data.rotatedAt).toBeTypeOf('string');

      const replenish = await app.request
        .post('/api/e2ee/devices/prekeys')
        .set(user.headers)
        .send({ oneTimePrekeys: [{ id: 10, publicKey: 'A'.repeat(43) }] });
      expect(replenish.status).toBe(204);

      // The registry consumes the lowest prekey id first, so drain the two
      // keys installed by rotation before the replenished key is returned.
      for (const expectedId of [1, 2]) {
        const drained = await app.request.get(bundlePath).set(user.headers);
        expect(drained.status).toBe(200);
        expect(drained.body.data.oneTimePrekey.id).toBe(expectedId);
      }

      const bundle = await app.request.get(bundlePath).set(user.headers);
      expect(bundle.status).toBe(200);
      expect(bundle.body.data.oneTimePrekey.publicKey).toBe('A'.repeat(43));

      const exhausted = await app.request.get(bundlePath).set(user.headers);
      expect(exhausted.status).toBe(409);
      expect(exhausted.body.error.code).toBe('E2EE_PREKEY_EXHAUSTED');

      const missing = await app.request
        .get(`/api/e2ee/users/${user.id}/devices/00000000-0000-7000-8000-0000000000ff/bundle`)
        .set(user.headers);
      expect(missing.status).toBe(404);
      expect(missing.body.error.code).toBe('E2EE_DEVICE_NOT_FOUND');
    } finally {
      await app.close();
    }
  });

  it('requires bearer authentication and a verified email', async () => {
    const app = await TestApp.create();
    const fixture = new MessagingApiFixture(app);

    try {
      await app.clearDatabase();
      const unverified = await fixture.unverifiedUser('Unverified E2EE User');

      const anonymous = await app.request.get('/api/e2ee/devices');
      expect(anonymous.status).toBe(401);

      const unverifiedResponse = await app.request.get('/api/e2ee/devices').set(unverified.headers);
      expect(unverifiedResponse.status).toBe(403);
      expect(unverifiedResponse.body.error.code).toBe('EMAIL_NOT_VERIFIED');
    } finally {
      await app.close();
    }
  });
});
