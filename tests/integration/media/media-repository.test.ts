import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PostgresMediaObjectRepository } from '@/modules/media/data/postgres-media-object.repository.js';
import { MediaObjectKeyFactory } from '@/modules/media/logic/media-object-key.factory.js';
import { AuthFixture } from '../../fixtures/auth.fixture.js';
import { TestApp } from '../../helpers/test-app.js';

describe('PostgresMediaObjectRepository', () => {
  let app: TestApp;
  let auth: AuthFixture;
  let repository: PostgresMediaObjectRepository;

  beforeAll(async () => {
    app = await TestApp.create();
    auth = new AuthFixture(app);
    repository = new PostgresMediaObjectRepository(app.db, new MediaObjectKeyFactory());
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await app.clearDatabase();
  });

  it('creates a pending record with a server-generated key', async () => {
    const user = await auth.createUser({ email: 'media-repo-create@example.com' });
    const record = await repository.create({
      ownerUserId: user.id,
      contentType: 'image/png',
      sizeBytes: 42,
    });

    expect(record.status).toBe('pending');
    expect(record.objectKey).toMatch(new RegExp(`^media/${user.id}/[0-9a-f-]+\\.png$`));
    expect(record.sizeBytes).toBe(42);
    expect(record.sha256).toBeNull();
  });

  it('scopes reads, transitions, and deletes to the owner', async () => {
    const owner = await auth.createUser({ email: 'media-repo-owner@example.com' });
    const other = await auth.createUser({ email: 'media-repo-other@example.com' });
    const created = await repository.create({
      ownerUserId: owner.id,
      contentType: 'image/png',
      sizeBytes: 10,
    });

    expect(await repository.findOwned(created.id, other.id)).toBeNull();
    expect(
      await repository.transitionToReady(created.id, other.id, 'a'.repeat(64), 'version-1'),
    ).toBeNull();

    const hash = 'b'.repeat(64);
    const ready = await repository.transitionToReady(created.id, owner.id, hash, 'version-1');
    expect(ready?.status).toBe('ready');
    expect(ready?.sha256).toBe(hash);
    expect(ready?.versionId).toBe('version-1');
    expect(ready?.finalizedAt).toBeInstanceOf(Date);
    expect(await repository.transitionToReady(created.id, owner.id, hash, 'version-1')).toBeNull();
    expect(await repository.deleteOwned(created.id, other.id)).toBe(false);
    expect(await repository.deleteOwned(created.id, owner.id)).toBe(true);
  });

  it('records quarantine and failed states with bounded diagnostics', async () => {
    const user = await auth.createUser({ email: 'media-repo-scan@example.com' });
    const created = await repository.create({
      ownerUserId: user.id,
      contentType: 'application/pdf',
      sizeBytes: 20,
    });

    const quarantined = await repository.transitionToQuarantined(
      created.id,
      user.id,
      'Eicar-Test-Signature',
      null,
      'version-quarantined',
    );
    expect(quarantined?.status).toBe('quarantined');
    expect(quarantined?.versionId).toBe('version-quarantined');
    expect(quarantined?.scanSignature).toBe('Eicar-Test-Signature');

    const second = await repository.create({
      ownerUserId: user.id,
      contentType: 'application/pdf',
      sizeBytes: 20,
    });
    const failed = await repository.markFailed(second.id, user.id, 'metadata mismatch', null);
    expect(failed?.status).toBe('failed');
    expect(failed?.scanError).toBe('metadata mismatch');
    expect(failed?.versionId).toBeNull();
  });

  it('persists the scanned version id through conditional transitions', async () => {
    const user = await auth.createUser({ email: 'media-repo-version@example.com' });

    const ready = await repository.create({
      ownerUserId: user.id,
      contentType: 'image/png',
      sizeBytes: 10,
    });
    const readyRecord = await repository.transitionToReady(
      ready.id,
      user.id,
      'a'.repeat(64),
      'version-ready',
    );
    expect(readyRecord?.versionId).toBe('version-ready');

    const quarantined = await repository.create({
      ownerUserId: user.id,
      contentType: 'image/png',
      sizeBytes: 10,
    });
    const quarantinedRecord = await repository.transitionToQuarantined(
      quarantined.id,
      user.id,
      'Eicar-Test-Signature',
      null,
      'version-quarantined',
    );
    expect(quarantinedRecord?.versionId).toBe('version-quarantined');

    const failed = await repository.create({
      ownerUserId: user.id,
      contentType: 'image/png',
      sizeBytes: 10,
    });
    const failedRecord = await repository.markFailed(
      failed.id,
      user.id,
      'storage read failure',
      'version-failed',
    );
    expect(failedRecord?.versionId).toBe('version-failed');
  });
});
