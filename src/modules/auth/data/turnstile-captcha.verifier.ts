import { inject, injectable } from 'inversify';
import type { Logger } from 'pino';
import type { AppConfig } from '@/core/config/app.config.js';
import { CORE_TYPES } from '@/core/container/core.types.js';
import { CaptchaUnavailableException } from '@/core/errors/domain.error.js';
import type {
  CaptchaVerificationInput,
  CaptchaVerifier,
} from '@/modules/auth/logic/ports/captcha.verifier.js';

interface TurnstileResponse {
  success?: unknown;
  hostname?: unknown;
  action?: unknown;
  'error-codes'?: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/**
 * Cloudflare Turnstile siteverify client.
 *
 * Provider outages and malformed responses throw `CaptchaUnavailableException`
 * so the API fails closed with a distinct 503 instead of blaming the user for a
 * bad token. A well-formed rejection returns `false`.
 */
@injectable()
export class TurnstileCaptchaVerifier implements CaptchaVerifier {
  readonly enabled = true;

  constructor(
    @inject(CORE_TYPES.Config) private readonly config: AppConfig,
    @inject(CORE_TYPES.Logger) private readonly logger: Logger,
  ) {}

  async verify(input: CaptchaVerificationInput): Promise<boolean> {
    const payload = await this.requestVerification(input);

    if (payload.success !== true) {
      this.logger.warn(
        {
          errorCodes: payload['error-codes'],
          remoteIp: input.remoteIp,
        },
        'Turnstile rejected a captcha token',
      );

      return false;
    }

    const { expectedHostname, expectedAction } = this.config.captcha;

    if (expectedHostname !== null && payload.hostname !== expectedHostname) {
      this.logger.warn(
        { expectedHostname, receivedHostname: payload.hostname },
        'Turnstile hostname mismatch',
      );

      return false;
    }

    if (expectedAction !== null && payload.action !== expectedAction) {
      this.logger.warn(
        { expectedAction, receivedAction: payload.action },
        'Turnstile action mismatch',
      );

      return false;
    }

    return true;
  }

  private async requestVerification(input: CaptchaVerificationInput): Promise<TurnstileResponse> {
    const { secret, verifyUrl, timeoutMs } = this.config.captcha;

    if (!secret) {
      throw new CaptchaUnavailableException('Captcha is enabled without a provider secret');
    }

    const body = new URLSearchParams({
      secret,
      response: input.token,
    });

    if (input.remoteIp) {
      body.set('remoteip', input.remoteIp);
    }

    let response: Response;

    try {
      response = await fetch(verifyUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new CaptchaUnavailableException('Captcha provider is unreachable', { cause: error });
    }

    if (!response.ok) {
      throw new CaptchaUnavailableException(`Captcha provider returned HTTP ${response.status}`);
    }

    let payload: unknown;

    try {
      payload = await response.json();
    } catch (error) {
      throw new CaptchaUnavailableException('Captcha provider returned malformed JSON', {
        cause: error,
      });
    }

    if (!isRecord(payload)) {
      throw new CaptchaUnavailableException('Captcha provider returned an unexpected response');
    }

    return payload as TurnstileResponse;
  }
}
