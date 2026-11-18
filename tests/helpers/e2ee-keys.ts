import { generateKeyPairSync, sign } from 'node:crypto';

function rawPublic(publicKey: ReturnType<typeof generateKeyPairSync>['publicKey']): string {
  return publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64url');
}

/** Builds a signed registration payload using throwaway client-side key pairs. */
export function makeE2eeRegistration(oneTimeCount = 2) {
  const signing = generateKeyPairSync('ed25519');
  const identity = generateKeyPairSync('x25519');
  const signedPrekey = generateKeyPairSync('x25519');
  const signingPublicKey = rawPublic(signing.publicKey);
  const identityPublicKey = rawPublic(identity.publicKey);
  const signedPrekeyPublicKey = rawPublic(signedPrekey.publicKey);

  return {
    signingPublicKey,
    identityPublicKey,
    identitySignature: sign(
      null,
      Buffer.concat([Buffer.from('e2ee-identity:'), Buffer.from(identityPublicKey, 'base64url')]),
      signing.privateKey,
    ).toString('base64url'),
    signedPrekey: {
      id: 1,
      publicKey: signedPrekeyPublicKey,
      signature: sign(
        null,
        Buffer.concat([
          Buffer.from('e2ee-signed-prekey:1:'),
          Buffer.from(signedPrekeyPublicKey, 'base64url'),
        ]),
        signing.privateKey,
      ).toString('base64url'),
    },
    oneTimePrekeys: Array.from({ length: oneTimeCount }, (_, index) => ({
      id: index + 1,
      publicKey: rawPublic(generateKeyPairSync('x25519').publicKey),
    })),
  };
}
