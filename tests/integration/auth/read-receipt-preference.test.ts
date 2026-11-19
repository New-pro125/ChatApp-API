import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CORE_TYPES } from '@/core/container/core.types.js';
import type { ReadReceiptPreferenceReader } from '@/core/privacy/read-receipt-preference.reader.js';
import { AuthFixture } from '../../fixtures/auth.fixture.js';
import { TestApp } from '../../helpers/test-app.js';

describe('Core: read receipt preference reader', () => {
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

  it('is mutual, defaults on, and reflects a privacy change immediately', async () => {
    const alice = await auth.createUser();
    const bob = await auth.createUser();
    const reader = app.container.get<ReadReceiptPreferenceReader>(
      CORE_TYPES.ReadReceiptPreferenceReader,
    );

    // Neither user has a settings row yet; the defaults must apply.
    expect(await reader.areEnabledForPair(alice.id, bob.id)).toBe(true);

    const tokens = await auth.mintTokens(alice);
    const updated = await app.request
      .patch('/api/auth/me/privacy')
      .set(auth.bearerHeader(tokens.accessToken))
      .send({ readReceiptsEnabled: false });
    expect(updated.status).toBe(200);

    expect(await reader.areEnabledForPair(alice.id, bob.id)).toBe(false);
    expect(await reader.areEnabledForPair(bob.id, alice.id)).toBe(false);
  });
});
