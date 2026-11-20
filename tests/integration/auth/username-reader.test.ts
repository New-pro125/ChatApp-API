import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CORE_TYPES } from '@/core/container/core.types.js';
import type { UsernameReader } from '@/core/users/username.reader.js';
import { AuthFixture } from '../../fixtures/auth.fixture.js';
import { TestApp } from '../../helpers/test-app.js';

describe('UsernameReader', () => {
  let app: TestApp;
  let auth: AuthFixture;
  let reader: UsernameReader;

  beforeAll(async () => {
    app = await TestApp.create();
    auth = new AuthFixture(app);
    reader = app.container.get<UsernameReader>(CORE_TYPES.UsernameReader);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await app.clearDatabase();
    auth.emails.clear();
  });

  it('resolves a username case-insensitively and ignores unknown names', async () => {
    const user = await auth.createUser();
    await app.pool.query(`UPDATE users SET username = $1 WHERE id = $2`, ['alice_01', user.id]);

    expect(await reader.findByUsername('alice_01')).toBe(user.id);
    expect(await reader.findByUsername('ALICE_01')).toBe(user.id);
    expect(await reader.findByUsername('nobody_01')).toBeNull();
  });

  it('ignores users without a username', async () => {
    const user = await auth.createUser();
    expect(user.username).toBeNull();
    expect(await reader.findByUsername('missing_01')).toBeNull();
  });
});
