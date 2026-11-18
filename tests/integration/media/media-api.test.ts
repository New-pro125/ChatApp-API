import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AuthFixture } from '../../fixtures/auth.fixture.js';
import {
  type DownloadTicketResponse,
  MediaFixture,
  type UploadTicketResponse,
} from '../../fixtures/media.fixture.js';
import { expectError, expectNoContent, expectSuccess } from '../../helpers/assertions.js';
import { TestApp } from '../../helpers/test-app.js';

const BYTES = Buffer.from('small png stand-in');

interface VerifiedContext {
  userId: string;
  header: { Authorization: string };
}

describe('Media API', () => {
  let app: TestApp;
  let auth: AuthFixture;
  let media: MediaFixture;

  beforeAll(async () => {
    app = await TestApp.create();
    auth = new AuthFixture(app);
    media = new MediaFixture(app);
  });

  afterAll(async () => {
    await media.cleanup();
    await app.close();
  });

  beforeEach(async () => {
    await app.clearDatabase();
    media.scanner.mode = 'clean';
  });

  const verified = async (email: string): Promise<VerifiedContext> => {
    const user = await auth.createUser({ email, emailVerifiedAt: new Date() });
    const tokens = await auth.mintTokens(user);
    return { userId: user.id, header: auth.bearerHeader(tokens.accessToken) };
  };

  const createUpload = async (header: { Authorization: string }) =>
    expectSuccess<UploadTicketResponse>(
      await app.request
        .post('/api/media/uploads')
        .set(header)
        .send({ contentType: 'image/png', sizeBytes: BYTES.length }),
      201,
    );

  const staged = async (header: { Authorization: string }) => {
    const ticket = await createUpload(header);
    media.track(ticket);
    await media.put(ticket, BYTES, 'image/png');
    return ticket;
  };

  it('uploads, scans, downloads, and deletes a clean object', async () => {
    const { header } = await verified('media-api-clean@example.com');
    const ticket = await staged(header);

    const finalized = expectSuccess<DownloadTicketResponse>(
      await app.request.post(`/api/media/${ticket.mediaId}/finalize`).set(header),
      200,
    );
    expect(finalized.status).toBe('ready');
    expect(finalized.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(finalized.downloadUrl).toContain('X-Amz-Signature=');

    const download = expectSuccess<DownloadTicketResponse>(
      await app.request.get(`/api/media/${ticket.mediaId}`).set(header),
      200,
    );
    expect(download.downloadUrl).toBeTruthy();

    expectNoContent(await app.request.delete(`/api/media/${ticket.mediaId}`).set(header));
    expectError(
      await app.request.get(`/api/media/${ticket.mediaId}`).set(header),
      404,
      'NOT_FOUND',
    );
  });

  it('keeps serving the scanned bytes after the presigned PUT is reused', async () => {
    const { header } = await verified('media-api-version@example.com');
    const ticket = await staged(header);

    const finalized = expectSuccess<DownloadTicketResponse>(
      await app.request.post(`/api/media/${ticket.mediaId}/finalize`).set(header),
      200,
    );

    const stored = await app.pool.query('SELECT version_id FROM media_objects WHERE id = $1', [
      ticket.mediaId,
    ]);
    const versionId = stored.rows[0]?.version_id;
    expect(typeof versionId).toBe('string');
    expect(new URL(finalized.downloadUrl).searchParams.get('versionId')).toBe(versionId);

    // Same presigned PUT, same signed Content-Length, different bytes: the attack
    // that the scanned-version pin must defeat.
    const overwritten = Buffer.from(BYTES);
    overwritten.write('EVIL', 10, 'ascii');
    await media.put(ticket, overwritten, 'image/png');

    const issuedResponse = await fetch(finalized.downloadUrl);
    expect(issuedResponse.status).toBe(200);
    expect(Buffer.from(await issuedResponse.arrayBuffer())).toEqual(BYTES);

    const refreshed = expectSuccess<DownloadTicketResponse>(
      await app.request.get(`/api/media/${ticket.mediaId}`).set(header),
      200,
    );
    expect(new URL(refreshed.downloadUrl).searchParams.get('versionId')).toBe(versionId);
    const refreshedResponse = await fetch(refreshed.downloadUrl);
    expect(refreshedResponse.status).toBe(200);
    expect(Buffer.from(await refreshedResponse.arrayBuffer())).toEqual(BYTES);
  });

  it('rejects invalid content types and oversized requests', async () => {
    const { header } = await verified('media-api-validation@example.com');

    expectError(
      await app.request
        .post('/api/media/uploads')
        .set(header)
        .send({ contentType: 'image/svg+xml', sizeBytes: 4 }),
      400,
      'VALIDATION_ERROR',
    );
    expectError(
      await app.request
        .post('/api/media/uploads')
        .set(header)
        .send({ contentType: 'image/png', sizeBytes: 52_428_801 }),
      400,
      'VALIDATION_ERROR',
    );
  });

  it('requires authentication and verified email on every media route', async () => {
    const { userId, header } = await verified('media-api-verified@example.com');
    const ticket = await staged(header);

    expectError(await app.request.post('/api/media/uploads').send({}), 401, 'UNAUTHORIZED');

    const unverified = await auth.createUser({ email: 'media-api-unverified@example.com' });
    const tokens = await auth.mintTokens(unverified);
    const unverifiedHeader = auth.bearerHeader(tokens.accessToken);

    expectError(
      await app.request
        .post('/api/media/uploads')
        .set(unverifiedHeader)
        .send({ contentType: 'image/png', sizeBytes: 4 }),
      403,
      'EMAIL_NOT_VERIFIED',
    );
    expectError(
      await app.request.post(`/api/media/${ticket.mediaId}/finalize`).set(unverifiedHeader),
      403,
      'EMAIL_NOT_VERIFIED',
    );
    expectError(
      await app.request.get(`/api/media/${ticket.mediaId}`).set(unverifiedHeader),
      403,
      'EMAIL_NOT_VERIFIED',
    );
    expectError(
      await app.request.delete(`/api/media/${ticket.mediaId}`).set(unverifiedHeader),
      403,
      'EMAIL_NOT_VERIFIED',
    );
    expect(userId).toBeTruthy();
  });

  it('hides object keys and download URLs from non-owners', async () => {
    const owner = await verified('media-api-owner@example.com');
    const other = await verified('media-api-other@example.com');
    const ticket = await staged(owner.header);

    for (const response of [
      await app.request.post(`/api/media/${ticket.mediaId}/finalize`).set(other.header),
      await app.request.get(`/api/media/${ticket.mediaId}`).set(other.header),
      await app.request.delete(`/api/media/${ticket.mediaId}`).set(other.header),
    ]) {
      expectError(response, 404, 'NOT_FOUND');
      expect(JSON.stringify(response.body)).not.toContain(ticket.objectKey);
      expect(JSON.stringify(response.body)).not.toContain('downloadUrl');
      expect(JSON.stringify(response.body)).not.toContain('sha256');
    }
  });

  it('rejects a finalize when the S3 object is missing', async () => {
    const { header } = await verified('media-api-missing@example.com');
    const ticket = await createUpload(header);
    media.track(ticket);

    expectError(
      await app.request.post(`/api/media/${ticket.mediaId}/finalize`).set(header),
      404,
      'NOT_FOUND',
    );
  });

  it('rejects a finalized upload whose S3 metadata does not match the ticket', async () => {
    const { header } = await verified('media-api-mismatch@example.com');
    const ticket = await staged(header);

    // S3 rejects a PUT with a different signed Content-Type, so simulate a
    // substitution by changing the server-side expectation after the upload.
    await app.pool.query('UPDATE media_objects SET content_type = $1 WHERE id = $2', [
      'image/gif',
      ticket.mediaId,
    ]);

    expectError(
      await app.request.post(`/api/media/${ticket.mediaId}/finalize`).set(header),
      400,
      'VALIDATION_ERROR',
    );

    const row = await app.pool.query('SELECT status, version_id FROM media_objects WHERE id = $1', [
      ticket.mediaId,
    ]);
    expect(row.rows[0]?.status).toBe('failed');
    expect(typeof row.rows[0]?.version_id).toBe('string');
  });

  it('quarantines an infected object without issuing a download URL', async () => {
    const { header } = await verified('media-api-infected@example.com');
    const ticket = await staged(header);
    media.scanner.mode = 'infected';

    const result = expectError(
      await app.request.post(`/api/media/${ticket.mediaId}/finalize`).set(header),
      422,
      'MEDIA_INFECTED',
    );
    expect(JSON.stringify(result)).not.toContain(ticket.objectKey);

    expectError(
      await app.request.get(`/api/media/${ticket.mediaId}`).set(header),
      409,
      'MEDIA_NOT_READY',
    );

    const row = await app.pool.query(
      'SELECT status, scan_signature FROM media_objects WHERE id = $1',
      [ticket.mediaId],
    );
    expect(row.rows[0]).toMatchObject({
      status: 'quarantined',
      scan_signature: 'Eicar-Test-Signature',
    });
  });

  it('fails closed on a scanner outage and permits a later retry', async () => {
    const { header } = await verified('media-api-outage@example.com');
    const ticket = await staged(header);
    media.scanner.mode = 'unavailable';

    expectError(
      await app.request.post(`/api/media/${ticket.mediaId}/finalize`).set(header),
      503,
      'MEDIA_SCAN_UNAVAILABLE',
    );

    const pending = await app.pool.query('SELECT status FROM media_objects WHERE id = $1', [
      ticket.mediaId,
    ]);
    expect(pending.rows[0]?.status).toBe('pending');

    media.scanner.mode = 'clean';
    const retry = expectSuccess<DownloadTicketResponse>(
      await app.request.post(`/api/media/${ticket.mediaId}/finalize`).set(header),
      200,
    );
    expect(retry.status).toBe('ready');
  });

  it('allows only one winner when finalize races', async () => {
    const { header } = await verified('media-api-race@example.com');
    const ticket = await staged(header);

    const results = await Promise.allSettled([
      app.request.post(`/api/media/${ticket.mediaId}/finalize`).set(header),
      app.request.post(`/api/media/${ticket.mediaId}/finalize`).set(header),
    ]);

    const successes = results.filter(
      (result) => result.status === 'fulfilled' && result.value.status === 200,
    );
    const conflicts = results.filter(
      (result) => result.status === 'fulfilled' && result.value.status === 409,
    );
    expect(successes).toHaveLength(1);
    expect(conflicts).toHaveLength(1);
  });

  it('honors the explicit MEDIA_SCAN_REQUIRED=false bypass', async () => {
    const { header } = await verified('media-api-bypass@example.com');
    const ticket = await staged(header);
    media.useBypass();

    const result = expectSuccess<DownloadTicketResponse>(
      await app.request.post(`/api/media/${ticket.mediaId}/finalize`).set(header),
      200,
    );
    expect(result.status).toBe('ready');
    expect(result.sha256).toBeNull();
  });
});
