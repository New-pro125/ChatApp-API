import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { makeE2eeRegistration } from '../../helpers/e2ee-keys.js';
import { TestApp } from '../../helpers/test-app.js';
import { type ApiUser, MessagingApiFixture } from './messaging-api.fixture.js';

const nonce = 'A'.repeat(16);
const ephemeralPublicKey = 'A'.repeat(43);

function ciphertextFor(recipientDeviceId: string, plaintext = 'ciphertext') {
  return {
    recipientDeviceId,
    ciphertext: Buffer.from(plaintext).toString('base64url'),
    nonce,
    ephemeralPublicKey,
  };
}

interface SecretUser {
  readonly user: ApiUser;
  readonly deviceId: string;
}

describe('secret chat security boundaries', () => {
  let app: TestApp;
  let fixture: MessagingApiFixture;

  beforeAll(async () => {
    app = await TestApp.create();
    fixture = new MessagingApiFixture(app);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await app.clearDatabase();
    fixture.auth.emails.clear();
  });

  async function userWithDevice(displayName: string, prekeyCount = 2): Promise<SecretUser> {
    const user = await fixture.verifiedUser(displayName);
    const { deviceId } = await fixture.registerDevice(user, prekeyCount);

    return { user, deviceId };
  }

  function secretChat(first: SecretUser, second: SecretUser): Promise<string> {
    return fixture.openSecretChat(second.user.id, first.user.headers);
  }


  it('creates one secret chat with both members when both sides open concurrently', async () => {
    const alice = await userWithDevice('Alice Concurrent Open');
    const bob = await userWithDevice('Bob Concurrent Open');

    const responses = await Promise.all([
      app.request
        .post('/api/chats/secret')
        .set(alice.user.headers)
        .send({ participantId: bob.user.id }),
      app.request
        .post('/api/chats/secret')
        .set(bob.user.headers)
        .send({ participantId: alice.user.id }),
    ]);
    const statuses = responses.map((response) => response.status).sort();

    expect(statuses).toEqual([200, 201]);

    const chatId = responses[0]?.body.data.id as string;
    expect(responses[1]?.body.data.id).toBe(chatId);

    const members = await app.pool.query<{ count: number }>(
      'select count(*)::int as count from chat_members where chat_id = $1',
      [chatId],
    );
    expect(members.rows[0]?.count).toBe(2);

    const chats = await app.pool.query<{ count: number }>(
      "select count(*)::int as count from chats where direct_key like 'secret:%'",
    );
    expect(chats.rows[0]?.count).toBe(1);
  });
});
