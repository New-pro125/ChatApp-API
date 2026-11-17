import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuthFixture } from '../../fixtures/auth.fixture.js';
import { expectError, expectNoContent, expectSuccess } from '../../helpers/assertions.js';
import { TestApp } from '../../helpers/test-app.js';

interface BlockedUserResponse {
  id: string;
  username: string | null;
  displayName: string;
  avatarKey: string | null;
  blockedAt: string;
}

describe('Auth: Blocking', () => {
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

  it('blocks a user and lists them with profile fields', async () => {
    const blocker = await auth.createUser({ email: 'blocker@example.com' });
    const target = await auth.createUser({
      email: 'target@example.com',
      displayName: 'Target User',
    });
    const blockerTokens = await auth.mintTokens(blocker);
    const targetTokens = await auth.mintTokens(target);

    await app.request
      .patch('/api/auth/me')
      .set(auth.bearerHeader(targetTokens.accessToken))
      .send({ username: 'target_user' });

    const blocked = await app.request
      .post('/api/auth/me/blocks')
      .set(auth.bearerHeader(blockerTokens.accessToken))
      .send({ userId: target.id });

    expectNoContent(blocked);

    const res = await app.request
      .get('/api/auth/me/blocks')
      .set(auth.bearerHeader(blockerTokens.accessToken));

    const list = expectSuccess<BlockedUserResponse[]>(res, 200);

    expect(list).toHaveLength(1);
    expect(list[0]?.id).toBe(target.id);
    expect(list[0]?.username).toBe('target_user');
    expect(list[0]?.displayName).toBe('Target User');
    expect(list[0]?.avatarKey).toBeNull();
    expect(typeof list[0]?.blockedAt).toBe('string');
  });

  it('treats a repeated block as idempotent', async () => {
    const blocker = await auth.createUser({ email: 'idempotent-blocker@example.com' });
    const target = await auth.createUser({ email: 'idempotent-target@example.com' });
    const blockerTokens = await auth.mintTokens(blocker);

    await app.request
      .post('/api/auth/me/blocks')
      .set(auth.bearerHeader(blockerTokens.accessToken))
      .send({ userId: target.id });

    const second = await app.request
      .post('/api/auth/me/blocks')
      .set(auth.bearerHeader(blockerTokens.accessToken))
      .send({ userId: target.id });

    expectNoContent(second);

    const list = expectSuccess<BlockedUserResponse[]>(
      await app.request
        .get('/api/auth/me/blocks')
        .set(auth.bearerHeader(blockerTokens.accessToken)),
      200,
    );

    expect(list).toHaveLength(1);
  });

  it('unblocks a user and treats a repeated unblock as idempotent', async () => {
    const blocker = await auth.createUser({ email: 'unblocker@example.com' });
    const target = await auth.createUser({ email: 'unblock-target@example.com' });
    const blockerTokens = await auth.mintTokens(blocker);

    await app.request
      .post('/api/auth/me/blocks')
      .set(auth.bearerHeader(blockerTokens.accessToken))
      .send({ userId: target.id });

    const first = await app.request
      .delete(`/api/auth/me/blocks/${target.id}`)
      .set(auth.bearerHeader(blockerTokens.accessToken));

    expectNoContent(first);

    const second = await app.request
      .delete(`/api/auth/me/blocks/${target.id}`)
      .set(auth.bearerHeader(blockerTokens.accessToken));

    expectNoContent(second);

    const list = expectSuccess<BlockedUserResponse[]>(
      await app.request
        .get('/api/auth/me/blocks')
        .set(auth.bearerHeader(blockerTokens.accessToken)),
      200,
    );

    expect(list).toHaveLength(0);
  });

  it('rejects blocking yourself', async () => {
    const user = await auth.createUser({ email: 'self-block@example.com' });
    const tokens = await auth.mintTokens(user);

    const res = await app.request
      .post('/api/auth/me/blocks')
      .set(auth.bearerHeader(tokens.accessToken))
      .send({ userId: user.id });

    expectError(res, 400, 'VALIDATION_ERROR');
  });

  it('returns 404 when the target user does not exist', async () => {
    const user = await auth.createUser({ email: 'missing-target@example.com' });
    const tokens = await auth.mintTokens(user);

    const res = await app.request
      .post('/api/auth/me/blocks')
      .set(auth.bearerHeader(tokens.accessToken))
      .send({ userId: '01920000-0000-7000-8000-000000000000' });

    expectError(res, 404, 'NOT_FOUND');
  });

  it('requires authentication', async () => {
    const res = await app.request
      .post('/api/auth/me/blocks')
      .send({ userId: '01920000-0000-7000-8000-000000000000' });

    expectError(res, 401, 'UNAUTHORIZED');
  });

  it('stores blocks directionally', async () => {
    const first = await auth.createUser({ email: 'directional-first@example.com' });
    const second = await auth.createUser({ email: 'directional-second@example.com' });
    const firstTokens = await auth.mintTokens(first);
    const secondTokens = await auth.mintTokens(second);

    await app.request
      .post('/api/auth/me/blocks')
      .set(auth.bearerHeader(firstTokens.accessToken))
      .send({ userId: second.id });

    const secondList = expectSuccess<BlockedUserResponse[]>(
      await app.request.get('/api/auth/me/blocks').set(auth.bearerHeader(secondTokens.accessToken)),
      200,
    );

    expect(secondList).toHaveLength(0);

    const reverse = await app.request
      .post('/api/auth/me/blocks')
      .set(auth.bearerHeader(secondTokens.accessToken))
      .send({ userId: first.id });

    expectNoContent(reverse);

    const firstList = expectSuccess<BlockedUserResponse[]>(
      await app.request.get('/api/auth/me/blocks').set(auth.bearerHeader(firstTokens.accessToken)),
      200,
    );

    expect(firstList).toHaveLength(1);
  });
});
