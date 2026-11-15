import type { CaptchaVerifier } from '@/modules/auth/logic/ports/captcha.verifier.js';

export class StubCaptchaVerifier implements CaptchaVerifier {
  readonly enabled = true;
  readonly calls: Array<{ token: string; remoteIp: string | null }> = [];
  result = true;

  verify(input: { token: string; remoteIp: string | null }): Promise<boolean> {
    this.calls.push(input);

    return Promise.resolve(this.result);
  }

  reset(): void {
    this.result = true;
    this.calls.length = 0;
  }
}
