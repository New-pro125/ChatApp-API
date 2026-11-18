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

  it('rejects secret chat opens and sends when either user has blocked the other', async () => {
    const alice = await userWithDevice('Alice Blocked');
    const bob = await userWithDevice('Bob Blocked');
    const chatId = await secretChat(alice, bob);

    await fixture.block(alice.user.id, bob.user.id);

    const openByBlocker = await app.request
      .post('/api/chats/secret')
      .set(alice.user.headers)
      .send({ participantId: bob.user.id });
    expect(openByBlocker.status).toBe(403);
    expect(openByBlocker.body.error.code).toBe('USER_BLOCKED');

    const openByBlocked = await app.request
      .post('/api/chats/secret')
      .set(bob.user.headers)
      .send({ participantId: alice.user.id });
    expect(openByBlocked.status).toBe(403);
    expect(openByBlocked.body.error.code).toBe('USER_BLOCKED');

    const sendByBlocker = await app.request
      .post(`/api/chats/${chatId}/secret-messages`)
      .set(alice.user.headers)
      .send(ciphertextFor(bob.deviceId));
    expect(sendByBlocker.status).toBe(403);
    expect(sendByBlocker.body.error.code).toBe('USER_BLOCKED');

    const sendByBlocked = await app.request
      .post(`/api/chats/${chatId}/secret-messages`)
      .set(bob.user.headers)
      .send(ciphertextFor(alice.deviceId));
    expect(sendByBlocked.status).toBe(403);
    expect(sendByBlocked.body.error.code).toBe('USER_BLOCKED');
  });

  it('rejects opening a secret chat with yourself', async () => {
    const alice = await userWithDevice('Alice Self Secret');

    const response = await app.request
      .post('/api/chats/secret')
      .set(alice.user.headers)
      .send({ participantId: alice.user.id });

    expect(response.status).toBe(400);
  });

  it('rejects secret chat opens when either side has no registered device', async () => {
    const alice = await userWithDevice('Alice Missing Peer');
    const bob = await fixture.verifiedUser('Bob Missing Peer');

    const missingPeer = await app.request
      .post('/api/chats/secret')
      .set(alice.user.headers)
      .send({ participantId: bob.id });
    expect(missingPeer.status).toBe(404);
    expect(missingPeer.body.error.code).toBe('E2EE_DEVICE_NOT_FOUND');

    const carol = await fixture.verifiedUser('Carol Missing Caller');
    const dave = await userWithDevice('Dave Present Device');

    const missingCaller = await app.request
      .post('/api/chats/secret')
      .set(carol.headers)
      .send({ participantId: dave.user.id });
    expect(missingCaller.status).toBe(404);
    expect(missingCaller.body.error.code).toBe('E2EE_DEVICE_NOT_FOUND');
  });

  it('rejects secret history and secret sends from a non-member', async () => {
    const alice = await userWithDevice('Alice Member');
    const bob = await userWithDevice('Bob Member');
    const charlie = await userWithDevice('Charlie Outsider');
    const chatId = await secretChat(alice, bob);

    const nonMemberSend = await app.request
      .post(`/api/chats/${chatId}/secret-messages`)
      .set(charlie.user.headers)
      .send(ciphertextFor(bob.deviceId));
    expect(nonMemberSend.status).toBe(403);
    expect(nonMemberSend.body.error.code).toBe('NOT_CHAT_MEMBER');

    const nonMemberHistory = await app.request
      .get(`/api/chats/${chatId}/messages`)
      .set(charlie.user.headers);
    expect(nonMemberHistory.status).toBe(403);
    expect(nonMemberHistory.body.error.code).toBe('NOT_CHAT_MEMBER');
  });

  it('rejects a secret send from an unverified caller', async () => {
    const alice = await userWithDevice('Alice Verified Sender');
    const bob = await userWithDevice('Bob Verified Recipient');
    const chatId = await secretChat(alice, bob);
    const unverified = await fixture.unverifiedUser('Unverified Secret Sender');

    const response = await app.request
      .post(`/api/chats/${chatId}/secret-messages`)
      .set(unverified.headers)
      .send(ciphertextFor(bob.deviceId));

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('EMAIL_NOT_VERIFIED');
  });

  it('rejects recipient devices that belong to the sender or a third user', async () => {
    const alice = await userWithDevice('Alice Device Owner');
    const bob = await userWithDevice('Bob Device Owner');
    const charlie = await userWithDevice('Charlie Third Party');
    const chatId = await secretChat(alice, bob);

    for (const recipientDeviceId of [alice.deviceId, charlie.deviceId]) {
      const response = await app.request
        .post(`/api/chats/${chatId}/secret-messages`)
        .set(alice.user.headers)
        .send(ciphertextFor(recipientDeviceId));

      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('E2EE_DEVICE_NOT_FOUND');
    }
  });

  it('returns CONFLICT for duplicate one-time prekey ids on replenishment', async () => {
    const alice = await userWithDevice('Alice Prekeys', 2);
    const publicKey = 'A'.repeat(43);

    const existingId = await app.request
      .post('/api/e2ee/devices/prekeys')
      .set(alice.user.headers)
      .send({ oneTimePrekeys: [{ id: 1, publicKey }] });
    expect(existingId.status).toBe(409);
    expect(existingId.body.error.code).toBe('CONFLICT');

    const duplicateBatch = await app.request
      .post('/api/e2ee/devices/prekeys')
      .set(alice.user.headers)
      .send({
        oneTimePrekeys: [
          { id: 50, publicKey },
          { id: 50, publicKey },
        ],
      });
    expect(duplicateBatch.status).toBe(409);
    expect(duplicateBatch.body.error.code).toBe('CONFLICT');
  });

  it('rejects rotation for a user without a registered device', async () => {
    const user = await fixture.verifiedUser('Rotate Without Device');

    const response = await app.request
      .post('/api/e2ee/devices/rotate')
      .set(user.headers)
      .send(makeE2eeRegistration(1));

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('E2EE_DEVICE_NOT_FOUND');
  });

  type Registration = ReturnType<typeof makeE2eeRegistration>;
  const invalidRegistrations: Array<[string, (registration: Registration) => void]> = [
    [
      'a malformed identity key',
      (registration) => {
        registration.identityPublicKey = 'not-a-valid-key';
      },
    ],
    [
      'a tampered identity signature',
      (registration) => {
        const bytes = Buffer.from(registration.identitySignature, 'base64url');
        bytes.writeUInt8(bytes.readUInt8(0) ^ 0xff, 0);
        registration.identitySignature = bytes.toString('base64url');
      },
    ],
  ];

  it.each(invalidRegistrations)('rejects %s over HTTP', async (_name, mutate) => {
    const user = await fixture.verifiedUser(`Invalid Registration ${_name}`);
    const registration = makeE2eeRegistration(1);
    mutate(registration);

    const response = await app.request
      .post('/api/e2ee/devices')
      .set(user.headers)
      .send(registration);

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects deleting a secret message', async () => {
    const alice = await userWithDevice('Alice Delete');
    const bob = await userWithDevice('Bob Delete');
    const chatId = await secretChat(alice, bob);

    const sent = await app.request
      .post(`/api/chats/${chatId}/secret-messages`)
      .set(alice.user.headers)
      .send(ciphertextFor(bob.deviceId));
    expect(sent.status).toBe(201);

    const response = await app.request
      .delete(`/api/chats/${chatId}/messages/${sent.body.data.id}`)
      .set(alice.user.headers);
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('E2EE_NOT_ALLOWED');

    const rows = await app.pool.query<{ deleted_at: Date | null }>(
      'select deleted_at from messages where chat_id = $1 and id = $2',
      [chatId, sent.body.data.id],
    );
    expect(rows.rows[0]?.deleted_at).toBeNull();
  });

  it('rejects ciphertext values that pass Zod but are not canonical base64url', async () => {
    const alice = await userWithDevice('Alice Ciphertext');
    const bob = await userWithDevice('Bob Ciphertext');
    const chatId = await secretChat(alice, bob);

    const malformed = [
      { ...ciphertextFor(bob.deviceId), ciphertext: 'A' },
      { ...ciphertextFor(bob.deviceId), ephemeralPublicKey: `${'A'.repeat(42)}B` },
    ];

    for (const body of malformed) {
      const response = await app.request
        .post(`/api/chats/${chatId}/secret-messages`)
        .set(alice.user.headers)
        .send(body);

      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('serves exactly one of two concurrent bundle fetches for the last prekey', async () => {
    const alice = await fixture.verifiedUser('Alice Bundle Racer');
    const bob = await userWithDevice('Bob Bundle Racer', 1);
    const bundlePath = `/api/e2ee/users/${bob.user.id}/devices/${bob.deviceId}/bundle`;

    const responses = await Promise.all([
      app.request.get(bundlePath).set(alice.headers),
      app.request.get(bundlePath).set(alice.headers),
    ]);
    const statuses = responses.map((response) => response.status).sort();

    expect(statuses).toEqual([200, 409]);

    const exhausted = responses.find((response) => response.status === 409);
    expect(exhausted?.body.error.code).toBe('E2EE_PREKEY_EXHAUSTED');

    const rows = await app.pool.query<{ count: number }>(
      'select count(*)::int as count from e2ee_prekeys where device_id = $1',
      [bob.deviceId],
    );
    expect(rows.rows[0]?.count).toBe(0);
  });

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
