import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuthFixture } from '../../fixtures/auth.fixture.js';
import { TestApp } from '../../helpers/test-app.js';

describe('media_objects schema', () => {
  let app: TestApp;
  let auth: AuthFixture;

  beforeAll(async () => {
    app = await TestApp.create();
    auth = new AuthFixture(app);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await app.clearDatabase();
  });

  const insert = (ownerId: string, overrides: Record<string, unknown> = {}) => {
    const values = {
      owner_user_id: ownerId,
      object_key: `media/${ownerId}/01920000-0000-7000-8000-000000000001.png`,
      content_type: 'image/png',
      size_bytes: 12,
      status: 'pending',
      ...overrides,
    };
    const columns = Object.keys(values);
    const placeholders = columns.map((_, index) => `$${index + 1}`);
    return app.pool.query(
      `INSERT INTO media_objects (${columns.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING id`,
      columns.map((column) => values[column as keyof typeof values]),
    );
  };

  it('rejects an unknown status and a non-positive size', async () => {
    const user = await auth.createUser({ email: 'media-schema-status@example.com' });

    await expect(insert(user.id, { status: 'done' })).rejects.toThrow(/media_objects_status_check/);
    await expect(insert(user.id, { size_bytes: 0 })).rejects.toThrow(
      /media_objects_size_bytes_check/,
    );
  });

  it('rejects a malformed sha256 and an overlong object key', async () => {
    const user = await auth.createUser({ email: 'media-schema-hash@example.com' });

    await expect(insert(user.id, { sha256: 'not-a-hash' })).rejects.toThrow(
      /media_objects_sha256_check/,
    );
    await expect(insert(user.id, { object_key: 'x'.repeat(513) })).rejects.toThrow(
      /media_objects_object_key_length_check/,
    );
  });

  it('enforces unique object keys and cascades owner deletion', async () => {
    const user = await auth.createUser({ email: 'media-schema-owner@example.com' });
    const key = `media/${user.id}/01920000-0000-7000-8000-000000000002.png`;

    await insert(user.id, { object_key: key });
    await expect(insert(user.id, { object_key: key })).rejects.toThrow(/unique/);

    await app.pool.query('DELETE FROM users WHERE id = $1', [user.id]);
    const remaining = await app.pool.query(
      'SELECT id FROM media_objects WHERE owner_user_id = $1',
      [user.id],
    );
    expect(remaining.rowCount).toBe(0);
  });
});
