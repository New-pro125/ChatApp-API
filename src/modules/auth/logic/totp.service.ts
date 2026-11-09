import { inject, injectable } from 'inversify';
import { Secret, TOTP } from 'otpauth';
import type { AppConfig } from '@/core/config/app.config.js';
import { CORE_TYPES } from '@/core/container/core.types.js';

const TOTP_PERIOD_SECONDS = 30;
const TOTP_DIGITS = 6;
const SECRET_BYTES = 20;

/**
 * Wraps the `otpauth` primitives so the rest of the domain never handles
 * authenticator-specific details.
 */
@injectable()
export class TotpService {
  constructor(@inject(CORE_TYPES.Config) private readonly config: AppConfig) {}

  generateSecret(): string {
    return new Secret({ size: SECRET_BYTES }).base32;
  }

  createKeyUri(label: string, secret: string): string {
    return new TOTP({
      issuer: this.config.mfa.issuer,
      label,
      secret,
      algorithm: 'SHA1',
      digits: TOTP_DIGITS,
      period: TOTP_PERIOD_SECONDS,
    }).toString();
  }

  /**
   * Returns the absolute TOTP time step for a valid token, or `null` when the
   * token does not match inside the configured window.
   */
  validate(secret: string, token: string): number | null {
    const delta = TOTP.validate({
      token,
      secret,
      algorithm: 'SHA1',
      digits: TOTP_DIGITS,
      period: TOTP_PERIOD_SECONDS,
      window: this.config.mfa.totpWindow,
    });

    if (delta === null) {
      return null;
    }

    return TOTP.counter({ period: TOTP_PERIOD_SECONDS, timestamp: Date.now() }) + delta;
  }
}
