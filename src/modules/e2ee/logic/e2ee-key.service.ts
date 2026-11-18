import { createPublicKey, type KeyObject, verify } from 'node:crypto';
import { injectable } from 'inversify';
import type {
  E2eeCiphertextInput,
  E2eeCiphertextValidator,
} from '@/core/e2ee/e2ee-ciphertext.validator.js';
import { InvalidE2eeKeyException } from '@/core/errors/domain.error.js';

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const BASE64URL = /^[A-Za-z0-9_-]+$/;

export interface E2eeOneTimePrekeyInput {
  readonly id: number;
  readonly publicKey: string;
}

export interface E2eeSignedPrekeyInput extends E2eeOneTimePrekeyInput {
  readonly signature: string;
}

export interface E2eeRegistrationInput {
  readonly signingPublicKey: string;
  readonly identityPublicKey: string;
  readonly identitySignature: string;
  readonly signedPrekey: E2eeSignedPrekeyInput;
  readonly oneTimePrekeys: E2eeOneTimePrekeyInput[];
}

/** Validates public key encodings and Ed25519 signatures without keeping secrets. */
@injectable()
export class E2eeKeyService implements E2eeCiphertextValidator {
  assertRegistrationInput(input: E2eeRegistrationInput): void {
    const signingKey = this.ed25519Key(input.signingPublicKey, 'signingPublicKey');
    const identityKey = this.decode(input.identityPublicKey, 32, 'identityPublicKey');
    const identitySignature = this.decode(input.identitySignature, 64, 'identitySignature');
    const prekey = this.decode(input.signedPrekey.publicKey, 32, 'signedPrekey.publicKey');
    const prekeySignature = this.decode(input.signedPrekey.signature, 64, 'signedPrekey.signature');

    if (
      !this.hasValidSignature(
        signingKey,
        Buffer.concat([Buffer.from('e2ee-identity:'), identityKey]),
        identitySignature,
      )
    ) {
      throw new InvalidE2eeKeyException('Identity key signature is invalid');
    }

    if (
      !this.hasValidSignature(
        signingKey,
        Buffer.concat([Buffer.from(`e2ee-signed-prekey:${input.signedPrekey.id}:`), prekey]),
        prekeySignature,
      )
    ) {
      throw new InvalidE2eeKeyException('Signed prekey signature is invalid');
    }

    if (input.oneTimePrekeys.length < 1 || input.oneTimePrekeys.length > 100) {
      throw new InvalidE2eeKeyException('Provide between 1 and 100 one-time prekeys');
    }

    for (const item of input.oneTimePrekeys) {
      if (!Number.isInteger(item.id) || item.id < 1) {
        throw new InvalidE2eeKeyException('One-time prekey ids must be positive integers');
      }

      this.decode(item.publicKey, 32, 'oneTimePrekey.publicKey');
    }
  }

  assertCiphertextInput(input: E2eeCiphertextInput): void {
    if (input.ciphertext.length < 1 || input.ciphertext.length > 8192) {
      throw new InvalidE2eeKeyException('Ciphertext must be 1 to 8192 characters');
    }

    this.decode(input.ciphertext, Math.floor((input.ciphertext.length * 3) / 4), 'ciphertext');
    this.decode(input.nonce, 12, 'nonce');
    this.decode(input.ephemeralPublicKey, 32, 'ephemeralPublicKey');
  }

  private ed25519Key(value: string, label: string): KeyObject {
    const raw = this.decode(value, 32, label);

    return createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
      format: 'der',
      type: 'spki',
    });
  }

  private hasValidSignature(key: KeyObject, message: Buffer, signature: Buffer): boolean {
    return verify(null, message, key, signature);
  }

  private decode(value: string, expectedBytes: number, label: string): Buffer {
    if (!BASE64URL.test(value)) {
      throw new InvalidE2eeKeyException(`${label} must be base64url`);
    }

    const decoded = Buffer.from(value, 'base64url');

    if (decoded.length !== expectedBytes || decoded.toString('base64url') !== value) {
      throw new InvalidE2eeKeyException(`${label} has an invalid length or encoding`);
    }

    return decoded;
  }
}
