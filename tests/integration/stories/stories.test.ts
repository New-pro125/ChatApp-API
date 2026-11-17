import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuthFixture } from '../../fixtures/auth.fixture.js';
import { expectError, expectNoContent, expectSuccess } from '../../helpers/assertions.js';
import { TestApp } from '../../helpers/test-app.js';

interface StoryResponse {
  id: string;
  caption: string | null;
  mediaKey: string | null;
  expiresAt: string;
  createdAt: string;
}

describe('Stories', () => {
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

  it('creates a caption story and returns it with an expiry', async () => {
    const user = await auth.createUser({
      email: 'story-create@example.com',
      emailVerifiedAt: new Date(),
    });
    const tokens = await auth.mintTokens(user);

    const res = await app.request
      .post('/api/stories')
      .set(auth.bearerHeader(tokens.accessToken))
      .send({ caption: 'Hello stories' });

    const story = expectSuccess<StoryResponse>(res, 201);

    expect(story.id).toBeTruthy();
    expect(story.caption).toBe('Hello stories');
    expect(story.mediaKey).toBeNull();
    expect(new Date(story.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('creates a media story without a caption', async () => {
    const user = await auth.createUser({
      email: 'story-media@example.com',
      emailVerifiedAt: new Date(),
    });
    const tokens = await auth.mintTokens(user);

    const res = await app.request
      .post('/api/stories')
      .set(auth.bearerHeader(tokens.accessToken))
      .send({ mediaKey: 'stories/2026/photo.jpg' });

    const story = expectSuccess<StoryResponse>(res, 201);

    expect(story.caption).toBeNull();
    expect(story.mediaKey).toBe('stories/2026/photo.jpg');
  });

  it('rejects a story with neither caption nor media', async () => {
    const user = await auth.createUser({
      email: 'story-empty@example.com',
      emailVerifiedAt: new Date(),
    });
    const tokens = await auth.mintTokens(user);

    const res = await app.request
      .post('/api/stories')
      .set(auth.bearerHeader(tokens.accessToken))
      .send({});

    expectError(res, 400, 'VALIDATION_ERROR');
  });

  it('rejects story creation for unverified accounts', async () => {
    const user = await auth.createUser({ email: 'story-unverified@example.com' });
    const tokens = await auth.mintTokens(user);

    const res = await app.request
      .post('/api/stories')
      .set(auth.bearerHeader(tokens.accessToken))
      .send({ caption: 'Blocked' });

    expectError(res, 403, 'EMAIL_NOT_VERIFIED');
  });

  it('lists the caller stories newest first', async () => {
    const user = await auth.createUser({
      email: 'story-list@example.com',
      emailVerifiedAt: new Date(),
    });
    const tokens = await auth.mintTokens(user);

    await app.request
      .post('/api/stories')
      .set(auth.bearerHeader(tokens.accessToken))
      .send({ caption: 'First' });

    await app.request
      .post('/api/stories')
      .set(auth.bearerHeader(tokens.accessToken))
      .send({ caption: 'Second' });

    const list = expectSuccess<StoryResponse[]>(
      await app.request.get('/api/stories').set(auth.bearerHeader(tokens.accessToken)),
      200,
    );

    expect(list).toHaveLength(2);
    expect(list[0]?.caption).toBe('Second');
    expect(list[1]?.caption).toBe('First');
  });

  it('hides expired stories from the list', async () => {
    const user = await auth.createUser({
      email: 'story-expired@example.com',
      emailVerifiedAt: new Date(),
    });
    const tokens = await auth.mintTokens(user);

    const created = expectSuccess<StoryResponse>(
      await app.request
        .post('/api/stories')
        .set(auth.bearerHeader(tokens.accessToken))
        .send({ caption: 'Old news' }),
      201,
    );

    await app.pool.query(
      "UPDATE stories SET expires_at = now() - interval '1 hour' WHERE id = $1",
      [created.id],
    );

    const list = expectSuccess<StoryResponse[]>(
      await app.request.get('/api/stories').set(auth.bearerHeader(tokens.accessToken)),
      200,
    );

    expect(list).toHaveLength(0);
  });

  it('deletes an owned story and is a 404 for others', async () => {
    const owner = await auth.createUser({
      email: 'story-delete-owner@example.com',
      emailVerifiedAt: new Date(),
    });
    const other = await auth.createUser({
      email: 'story-delete-other@example.com',
      emailVerifiedAt: new Date(),
    });
    const ownerTokens = await auth.mintTokens(owner);
    const otherTokens = await auth.mintTokens(other);

    const story = expectSuccess<StoryResponse>(
      await app.request
        .post('/api/stories')
        .set(auth.bearerHeader(ownerTokens.accessToken))
        .send({ caption: 'Mine' }),
      201,
    );

    const forbidden = await app.request
      .delete(`/api/stories/${story.id}`)
      .set(auth.bearerHeader(otherTokens.accessToken));

    expectError(forbidden, 404, 'NOT_FOUND');

    const removed = await app.request
      .delete(`/api/stories/${story.id}`)
      .set(auth.bearerHeader(ownerTokens.accessToken));

    expectNoContent(removed);

    const list = expectSuccess<StoryResponse[]>(
      await app.request.get('/api/stories').set(auth.bearerHeader(ownerTokens.accessToken)),
      200,
    );

    expect(list).toHaveLength(0);
  });

  it('returns 404 when deleting an unknown story', async () => {
    const user = await auth.createUser({
      email: 'story-delete-missing@example.com',
      emailVerifiedAt: new Date(),
    });
    const tokens = await auth.mintTokens(user);

    const res = await app.request
      .delete('/api/stories/01920000-0000-7000-8000-000000000000')
      .set(auth.bearerHeader(tokens.accessToken));

    expectError(res, 404, 'NOT_FOUND');
  });

  it('lets a viewer read another user stories when visibility is everyone', async () => {
    const owner = await auth.createUser({
      email: 'story-view-owner@example.com',
      emailVerifiedAt: new Date(),
    });
    const viewer = await auth.createUser({
      email: 'story-view-viewer@example.com',
      emailVerifiedAt: new Date(),
    });
    const ownerTokens = await auth.mintTokens(owner);
    const viewerTokens = await auth.mintTokens(viewer);

    await app.request
      .post('/api/stories')
      .set(auth.bearerHeader(ownerTokens.accessToken))
      .send({ caption: 'Public story' });

    const list = expectSuccess<StoryResponse[]>(
      await app.request
        .get(`/api/stories/users/${owner.id}`)
        .set(auth.bearerHeader(viewerTokens.accessToken)),
      200,
    );

    expect(list).toHaveLength(1);
    expect(list[0]?.caption).toBe('Public story');
  });

  it('hides stories from viewers when visibility is nobody', async () => {
    const owner = await auth.createUser({
      email: 'story-private-owner@example.com',
      emailVerifiedAt: new Date(),
    });
    const viewer = await auth.createUser({
      email: 'story-private-viewer@example.com',
      emailVerifiedAt: new Date(),
    });
    const ownerTokens = await auth.mintTokens(owner);
    const viewerTokens = await auth.mintTokens(viewer);

    await app.request
      .patch('/api/auth/me/privacy')
      .set(auth.bearerHeader(ownerTokens.accessToken))
      .send({ storiesVisibility: 'nobody' });

    await app.request
      .post('/api/stories')
      .set(auth.bearerHeader(ownerTokens.accessToken))
      .send({ caption: 'Private story' });

    const viewerList = expectSuccess<StoryResponse[]>(
      await app.request
        .get(`/api/stories/users/${owner.id}`)
        .set(auth.bearerHeader(viewerTokens.accessToken)),
      200,
    );

    expect(viewerList).toHaveLength(0);

    const ownerList = expectSuccess<StoryResponse[]>(
      await app.request
        .get(`/api/stories/users/${owner.id}`)
        .set(auth.bearerHeader(ownerTokens.accessToken)),
      200,
    );

    expect(ownerList).toHaveLength(1);
  });

  it('requires authentication', async () => {
    const create = await app.request.post('/api/stories').send({ caption: 'Anon' });
    expectError(create, 401, 'UNAUTHORIZED');

    const list = await app.request.get('/api/stories');
    expectError(list, 401, 'UNAUTHORIZED');
  });
});
