import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuthFixture } from '../../fixtures/auth.fixture.js';
import { expectError, expectSuccess } from '../../helpers/assertions.js';
import { TestApp } from '../../helpers/test-app.js';

interface PrivacySettingsResponse {
  profilePhotoVisibility: 'everyone' | 'nobody';
  lastSeenVisibility: 'everyone' | 'nobody';
  storiesVisibility: 'everyone' | 'nobody';
  readReceiptsEnabled: boolean;
}

describe('Auth: Privacy settings', () => {
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

  it('returns permissive defaults for a new user', async () => {
    const user = await auth.createUser({ email: 'privacy-defaults@example.com' });
    const tokens = await auth.mintTokens(user);

    const res = await app.request
      .get('/api/auth/me/privacy')
      .set(auth.bearerHeader(tokens.accessToken));

    const data = expectSuccess<PrivacySettingsResponse>(res, 200);

    expect(data.profilePhotoVisibility).toBe('everyone');
    expect(data.lastSeenVisibility).toBe('everyone');
    expect(data.storiesVisibility).toBe('everyone');
    expect(data.readReceiptsEnabled).toBe(true);
  });

  it('updates every setting and persists them', async () => {
    const user = await auth.createUser({ email: 'privacy-update@example.com' });
    const tokens = await auth.mintTokens(user);

    const res = await app.request
      .patch('/api/auth/me/privacy')
      .set(auth.bearerHeader(tokens.accessToken))
      .send({
        profilePhotoVisibility: 'nobody',
        lastSeenVisibility: 'nobody',
        storiesVisibility: 'nobody',
        readReceiptsEnabled: false,
      });

    const updated = expectSuccess<PrivacySettingsResponse>(res, 200);

    expect(updated.profilePhotoVisibility).toBe('nobody');
    expect(updated.lastSeenVisibility).toBe('nobody');
    expect(updated.storiesVisibility).toBe('nobody');
    expect(updated.readReceiptsEnabled).toBe(false);

    const persisted = expectSuccess<PrivacySettingsResponse>(
      await app.request.get('/api/auth/me/privacy').set(auth.bearerHeader(tokens.accessToken)),
      200,
    );

    expect(persisted).toEqual(updated);
  });

  it('leaves omitted settings unchanged on a partial update', async () => {
    const user = await auth.createUser({ email: 'privacy-partial@example.com' });
    const tokens = await auth.mintTokens(user);

    await app.request
      .patch('/api/auth/me/privacy')
      .set(auth.bearerHeader(tokens.accessToken))
      .send({ profilePhotoVisibility: 'nobody', readReceiptsEnabled: false });

    const res = await app.request
      .patch('/api/auth/me/privacy')
      .set(auth.bearerHeader(tokens.accessToken))
      .send({ storiesVisibility: 'nobody' });

    const data = expectSuccess<PrivacySettingsResponse>(res, 200);

    expect(data.profilePhotoVisibility).toBe('nobody');
    expect(data.storiesVisibility).toBe('nobody');
    expect(data.lastSeenVisibility).toBe('everyone');
    expect(data.readReceiptsEnabled).toBe(false);
  });

  it.each([
    ['an unknown visibility value', { profilePhotoVisibility: 'contacts' }],
    ['an empty payload', {}],
  ])('returns 400 VALIDATION_ERROR for %s', async (_label, body) => {
    const user = await auth.createUser({ email: 'privacy-invalid@example.com' });
    const tokens = await auth.mintTokens(user);

    const res = await app.request
      .patch('/api/auth/me/privacy')
      .set(auth.bearerHeader(tokens.accessToken))
      .send(body);

    expectError(res, 400, 'VALIDATION_ERROR');
  });

  it('requires authentication', async () => {
    const res = await app.request
      .patch('/api/auth/me/privacy')
      .send({ storiesVisibility: 'nobody' });

    expectError(res, 401, 'UNAUTHORIZED');
  });

  it('does not modify another user settings', async () => {
    const changed = await auth.createUser({ email: 'privacy-changed@example.com' });
    const other = await auth.createUser({ email: 'privacy-other@example.com' });
    const changedTokens = await auth.mintTokens(changed);
    const otherTokens = await auth.mintTokens(other);

    await app.request
      .patch('/api/auth/me/privacy')
      .set(auth.bearerHeader(changedTokens.accessToken))
      .send({ lastSeenVisibility: 'nobody' });

    const data = expectSuccess<PrivacySettingsResponse>(
      await app.request.get('/api/auth/me/privacy').set(auth.bearerHeader(otherTokens.accessToken)),
      200,
    );

    expect(data.lastSeenVisibility).toBe('everyone');
  });
});
