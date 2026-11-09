import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { inject, injectable } from 'inversify';
import type { AppConfig } from '@/core/config/app.config.js';
import { CORE_TYPES } from '@/core/container/core.types.js';
import type { MfaSecretCipher } from '@/modules/auth/logic/ports/mfa-secret.cipher.js';

const VERSION = 'v1';
const IV_BYTES = 12;

@injectable()
export class AesMfaSecretCipher implements MfaSecretCipher {
  constructor(@inject(CORE_TYPES.Config) private readonly config: AppConfig) {}

  encrypt(secret: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.requireKey(), iv);
    const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    return [
      VERSION,
      iv.toString('base64url'),
      tag.toString('base64url'),
      encrypted.toString('base64url'),
    ].join('.');
  }

  decrypt(ciphertext: string): string {
    const [version, iv, tag, encrypted] = ciphertext.split('.');

    if (version !== VERSION || !iv || !tag || !encrypted) {
      throw new Error('Invalid MFA secret payload');
    }

    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.requireKey(),
      Buffer.from(iv, 'base64url'),
    );
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));

    return Buffer.concat([
      decipher.update(Buffer.from(encrypted, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }

  private requireKey(): Buffer {
    return this.config.mfa.requireEncryptionKey();
  }
}
