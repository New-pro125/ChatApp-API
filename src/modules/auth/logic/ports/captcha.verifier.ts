export interface CaptchaVerificationInput {
  token: string;
  remoteIp: string | null;
}

/**
 * Verifies a captcha token with an external provider.
 *
 * `enabled` is part of the port so `CaptchaService` can keep a single code path
 * while local development and tests bind a disabled implementation.
 */
export interface CaptchaVerifier {
  readonly enabled: boolean;
  verify(input: CaptchaVerificationInput): Promise<boolean>;
}
