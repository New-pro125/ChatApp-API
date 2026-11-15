import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OAuthProfile } from '@/modules/auth/logic/entities/oauth-profile.js';
import { AuthFixture } from '../../fixtures/auth.fixture.js';
import { TestApp } from '../../helpers/test-app.js';

describe('Auth: OAuth account linking', () => {
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
    auth.emails.clear();
  });

  it('verifies an existing unverified password account when a verified provider email links', async () => {
    const user = await auth.createUser({ email: 'oauth-link@example.com' });
    expect(user.emailVerifiedAt).toBeNull();

    const linked = await auth.linkOAuth(
      new OAuthProfile('github', 'github-100', user.email, true, 'OAuth Link'),
    );

    expect(linked.id).toBe(user.id);
    expect(linked.emailVerifiedAt).not.toBeNull();

    const rows = await app.pool.query<{ email_verified_at: Date | null }>(
      'SELECT email_verified_at FROM users WHERE id = $1',
      [user.id],
    );

    expect(rows.rows[0]?.email_verified_at).not.toBeNull();
  });

  it('reuses the existing account for repeated logins with the same provider account', async () => {
    const user = await auth.createUser({ email: 'oauth-repeat@example.com' });
    const profile = new OAuthProfile('github', 'github-200', user.email, true, 'Repeat User');

    const first = await auth.linkOAuth(profile);
    const second = await auth.linkOAuth(profile);

    expect(first.id).toBe(user.id);
    expect(second.id).toBe(user.id);

    const rows = await app.pool.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM oauth_accounts WHERE provider = $1 AND provider_account_id = $2',
      ['github', 'github-200'],
    );

    expect(rows.rows[0]?.count).toBe(1);
  });
});
