import { randomUUID } from 'node:crypto';
import argon2 from 'argon2';
import { injectable } from 'inversify';
import type { PasswordHasher } from '@/modules/auth/logic/ports/password.hasher.js';

@injectable()
export class Argon2PasswordHasher implements PasswordHasher {
  private readonly dummyHash = argon2.hash(randomUUID());

  hash(plain: string): Promise<string> {
    return argon2.hash(plain, {
      type: argon2.argon2id,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
    });
  }

  async verify(digest: string, plain: string): Promise<boolean> {
    try {
      return await argon2.verify(digest, plain);
    } catch {
      return false;
    }
  }

  async verifyDummy(plain: string): Promise<void> {
    const digest = await this.dummyHash;
    await argon2.verify(digest, plain);
  }
}
