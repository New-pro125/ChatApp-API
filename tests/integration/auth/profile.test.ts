import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuthFixture } from '../../fixtures/auth.fixture.js';
import { expectError, expectSuccess } from '../../helpers/assertions.js';
import { TestApp } from '../../helpers/test-app.js';

interface ProfileResponse {
  id: string;
  email: string;
  displayName: string;
  username: string | null;
  bio: string | null;
  phone: string | null;
  avatarKey: string | null;
}

describe('Auth: User profile', () => {
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

  it('returns null profile fields for a new user', async () => {
    const user = await auth.createUser({ email: 'profile-new@example.com' });
    const tokens = await auth.mintTokens(user);

    const res = await app.request.get('/api/auth/me').set(auth.bearerHeader(tokens.accessToken));

    const data = expectSuccess<ProfileResponse>(res, 200);

    expect(data.displayName).toBe(user.displayName);
    expect(data.username).toBeNull();
    expect(data.bio).toBeNull();
    expect(data.phone).toBeNull();
    expect(data.avatarKey).toBeNull();
  });

  it('updates and persists every profile field', async () => {
    const user = await auth.createUser({ email: 'profile-update@example.com' });
    const tokens = await auth.mintTokens(user);

    const res = await app.request
      .patch('/api/auth/me')
      .set(auth.bearerHeader(tokens.accessToken))
      .send({
        displayName: 'Alice Cooper',
        username: 'Alice_01',
        bio: 'Building things',
        phone: '+15551234567',
      });

    const updated = expectSuccess<ProfileResponse>(res, 200);

    expect(updated.displayName).toBe('Alice Cooper');
    expect(updated.username).toBe('alice_01');
    expect(updated.bio).toBe('Building things');
    expect(updated.phone).toBe('+15551234567');
    expect(updated.avatarKey).toBeNull();

    const persisted = expectSuccess<ProfileResponse>(
      await app.request.get('/api/auth/me').set(auth.bearerHeader(tokens.accessToken)),
      200,
    );

    expect(persisted.displayName).toBe('Alice Cooper');
    expect(persisted.username).toBe('alice_01');
    expect(persisted.bio).toBe('Building things');
    expect(persisted.phone).toBe('+15551234567');
  });

  it('clears nullable profile fields with null', async () => {
    const user = await auth.createUser({ email: 'profile-clear@example.com' });
    const tokens = await auth.mintTokens(user);

    await app.request
      .patch('/api/auth/me')
      .set(auth.bearerHeader(tokens.accessToken))
      .send({ displayName: 'Clear Me', username: 'clear_me', bio: 'Bio', phone: '+15550000001' });

    const res = await app.request
      .patch('/api/auth/me')
      .set(auth.bearerHeader(tokens.accessToken))
      .send({ username: null, bio: null, phone: null });

    const cleared = expectSuccess<ProfileResponse>(res, 200);

    expect(cleared.displayName).toBe('Clear Me');
    expect(cleared.username).toBeNull();
    expect(cleared.bio).toBeNull();
    expect(cleared.phone).toBeNull();
  });

  it('rejects a username that is already taken', async () => {
    const first = await auth.createUser({ email: 'profile-first@example.com' });
    const second = await auth.createUser({ email: 'profile-second@example.com' });
    const firstTokens = await auth.mintTokens(first);
    const secondTokens = await auth.mintTokens(second);

    await app.request
      .patch('/api/auth/me')
      .set(auth.bearerHeader(firstTokens.accessToken))
      .send({ username: 'shared_name' });

    const res = await app.request
      .patch('/api/auth/me')
      .set(auth.bearerHeader(secondTokens.accessToken))
      .send({ username: 'Shared_Name' });

    const error = expectError(res, 409, 'CONFLICT');
    expect(error.message).toContain('Username');
  });

  it('rejects a phone number that is already registered', async () => {
    const first = await auth.createUser({ email: 'profile-phone-first@example.com' });
    const second = await auth.createUser({ email: 'profile-phone-second@example.com' });
    const firstTokens = await auth.mintTokens(first);
    const secondTokens = await auth.mintTokens(second);

    await app.request
      .patch('/api/auth/me')
      .set(auth.bearerHeader(firstTokens.accessToken))
      .send({ phone: '+15550000002' });

    const res = await app.request
      .patch('/api/auth/me')
      .set(auth.bearerHeader(secondTokens.accessToken))
      .send({ phone: '+15550000002' });

    const error = expectError(res, 409, 'CONFLICT');
    expect(error.message).toContain('Phone');
  });

  it.each([
    ['a too-short username', { username: 'ab' }],
    ['a username starting with a digit', { username: '1alice' }],
    ['an invalid phone number', { phone: '555-1234' }],
    ['a bio over 70 characters', { bio: 'x'.repeat(71) }],
    ['an empty payload', {}],
  ])('returns 400 VALIDATION_ERROR for %s', async (_label, body) => {
    const user = await auth.createUser({ email: 'profile-invalid@example.com' });
    const tokens = await auth.mintTokens(user);

    const res = await app.request
      .patch('/api/auth/me')
      .set(auth.bearerHeader(tokens.accessToken))
      .send(body);

    expectError(res, 400, 'VALIDATION_ERROR');
  });

  it('ignores a client-supplied avatar key', async () => {
    const user = await auth.createUser({ email: 'profile-avatar@example.com' });
    const tokens = await auth.mintTokens(user);

    const res = await app.request
      .patch('/api/auth/me')
      .set(auth.bearerHeader(tokens.accessToken))
      .send({ displayName: 'Avatar User', avatarKey: 'users/avatar.png' });

    const data = expectSuccess<ProfileResponse>(res, 200);

    expect(data.displayName).toBe('Avatar User');
    expect(data.avatarKey).toBeNull();
  });

  it('requires authentication', async () => {
    const res = await app.request.patch('/api/auth/me').send({ displayName: 'Anonymous' });

    expectError(res, 401, 'UNAUTHORIZED');
  });

  it('does not modify another user profile', async () => {
    const updatedUser = await auth.createUser({ email: 'profile-updated@example.com' });
    const otherUser = await auth.createUser({ email: 'profile-other@example.com' });
    const updatedTokens = await auth.mintTokens(updatedUser);
    const otherTokens = await auth.mintTokens(otherUser);

    await app.request
      .patch('/api/auth/me')
      .set(auth.bearerHeader(updatedTokens.accessToken))
      .send({ username: 'only_mine', bio: 'Mine', phone: '+15550000003' });

    const other = expectSuccess<ProfileResponse>(
      await app.request.get('/api/auth/me').set(auth.bearerHeader(otherTokens.accessToken)),
      200,
    );

    expect(other.username).toBeNull();
    expect(other.bio).toBeNull();
    expect(other.phone).toBeNull();
  });
});
