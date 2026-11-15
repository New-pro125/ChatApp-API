import { inject, injectable } from 'inversify';
import { CaptchaInvalidException, CaptchaRequiredException } from '@/core/errors/domain.error.js';
import { AUTH_TYPES } from '@/modules/auth/auth.types.js';
import type { CaptchaVerifier } from '@/modules/auth/logic/ports/captcha.verifier.js';

/**
 * Enforces captcha verification before credential handling.
 *
 * Registration and login call this before creating users, hashing passwords, or
 * touching lockout counters, so bots cannot consume those resources.
 */
@injectable()
export class CaptchaService {
  constructor(@inject(AUTH_TYPES.CaptchaVerifier) private readonly verifier: CaptchaVerifier) {}

  async assertValid(token: string | undefined, remoteIp: string | null): Promise<void> {
    if (!this.verifier.enabled) {
      return;
    }

    if (!token) {
      throw new CaptchaRequiredException();
    }

    const valid = await this.verifier.verify({ token, remoteIp });

    if (!valid) {
      throw new CaptchaInvalidException();
    }
  }
}
