import { createHash, randomBytes, randomInt } from 'node:crypto';
import { injectable } from 'inversify';

@injectable()
export class TokenGenerator {
  generateOtp(): string {
    return randomInt(0, 1_000_000).toString().padStart(6, '0');
  }

  generateResetToken(): string {
    return randomBytes(32).toString('base64url');
  }

  hashResetToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  generateMfaChallengeToken(): string {
    return this.generateResetToken();
  }

  hashMfaChallengeToken(token: string): string {
    return this.hashResetToken(token);
  }

  generateRecoveryCode(): string {
    const value = randomBytes(10).toString('hex');

    return [value.slice(0, 5), value.slice(5, 10), value.slice(10, 15), value.slice(15, 20)].join(
      '-',
    );
  }

  hashRecoveryCode(code: string): string {
    const normalized = code.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();

    return createHash('sha256').update(normalized).digest('hex');
  }
}
