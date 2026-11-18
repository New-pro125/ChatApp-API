import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { InvalidE2eeKeyException } from '@/core/errors/domain.error.js';
import { E2eeKeyService } from '@/modules/e2ee/logic/e2ee-key.service.js';

function rawPublic(publicKey: ReturnType<typeof generateKeyPairSync>['publicKey']): string {
  return publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
}

function validRegistration() {
  const signing = generateKeyPairSync('ed25519');
  const identity = generateKeyPairSync('x25519');
  const prekey = generateKeyPairSync('x25519');
  const signingPublicKey = rawPublic(signing.publicKey);
  const identityPublicKey = rawPublic(identity.publicKey);
  const signedPrekeyPublicKey = rawPublic(prekey.publicKey);
  const identitySignature = sign(
    null,
    Buffer.concat([Buffer.from('e2ee-identity:'), Buffer.from(identityPublicKey, 'base64url')]),
    signing.privateKey,
  ).toString('base64url');
  const signedPrekeySignature = sign(
    null,
    Buffer.concat([
      Buffer.from('e2ee-signed-prekey:1:'),
      Buffer.from(signedPrekeyPublicKey, 'base64url'),
    ]),
    signing.privateKey,
  ).toString('base64url');

  return {
    signingPublicKey,
    identityPublicKey,
    identitySignature,
    signedPrekey: {
      id: 1,
      publicKey: signedPrekeyPublicKey,
      signature: signedPrekeySignature,
    },
    oneTimePrekeys: [{ id: 1, publicKey: rawPublic(generateKeyPairSync('x25519').publicKey) }],
  };
}

describe('E2eeKeyService', () => {
  const service = new E2eeKeyService();

  it('accepts correctly signed registration material', () => {
    expect(() => service.assertRegistrationInput(validRegistration())).not.toThrow();
  });

  it('rejects a tampered signed prekey', () => {
    const input = validRegistration();
    input.signedPrekey.publicKey = rawPublic(generateKeyPairSync('x25519').publicKey);

    expect(() => service.assertRegistrationInput(input)).toThrow(InvalidE2eeKeyException);
  });

  it('rejects a short nonce', () => {
    expect(() =>
      service.assertCiphertextInput({
        recipientDeviceId: 'device-1',
        ciphertext: 'YQ',
        nonce: 'YQ',
        ephemeralPublicKey: 'A'.repeat(43),
      }),
    ).toThrow(InvalidE2eeKeyException);
  });

  it('accepts an eight-byte ciphertext encoded as eleven base64url characters', () => {
    expect(() =>
      service.assertCiphertextInput({
        recipientDeviceId: 'device-1',
        ciphertext: 'AAAAAAAAAAA',
        nonce: 'A'.repeat(16),
        ephemeralPublicKey: 'A'.repeat(43),
      }),
    ).not.toThrow();
  });
});
