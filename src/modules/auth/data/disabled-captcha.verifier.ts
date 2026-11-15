import { injectable } from 'inversify';
import type { CaptchaVerifier } from '@/modules/auth/logic/ports/captcha.verifier.js';

/**
 * Captcha verifier used when `CAPTCHA_ENABLED=false`.
 *
 * Local development and the default test configuration do not require a
 * provider secret; production should enable Turnstile explicitly.
 */
@injectable()
export class DisabledCaptchaVerifier implements CaptchaVerifier {
  readonly enabled = false;

  verify(): Promise<boolean> {
    return Promise.resolve(true);
  }
}
