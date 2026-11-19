import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TestApp } from '../../helpers/test-app.js';

type DocumentedPath = Partial<Record<'get' | 'post' | 'delete', { operationId: string }>>;

describe('media route registration', () => {
  let app: TestApp;

  beforeAll(async () => {
    app = await TestApp.create();
  });

  afterAll(async () => {
    await app.close();
  });

  it('registers all four documented operations', async () => {
    const docs = await app.request.get('/api/openapi.json');
    expect(docs.status).toBe(200);
    const paths = docs.body.paths as Record<string, DocumentedPath | undefined>;
    expect(paths['/api/media/uploads']?.post?.operationId).toBe('media.createUpload');
    expect(paths['/api/media/:id/finalize']?.post?.operationId).toBe('media.finalize');
    expect(paths['/api/media/:id']?.get?.operationId).toBe('media.download');
    expect(paths['/api/media/:id']?.delete?.operationId).toBe('media.delete');
  });
});
