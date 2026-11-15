import type { EmailSender } from '@/modules/auth/logic/ports/email.sender.js';

/**
 * Email sender used by integration tests.
 *
 * It captures the codes that the application would have emailed so tests can
 * complete OTP and verification flows without a real SMTP server.
 */
export class CapturingEmailSender implements EmailSender {
  private readonly otps = new Map<string, string>();
  private readonly verificationCodes = new Map<string, string>();

  sendOtp(email: string, otp: string): Promise<void> {
    this.otps.set(email, otp);

    return Promise.resolve();
  }

  sendVerificationCode(email: string, code: string): Promise<void> {
    this.verificationCodes.set(email, code);

    return Promise.resolve();
  }

  otpFor(email: string): string | undefined {
    return this.otps.get(email);
  }

  verificationCodeFor(email: string): string | undefined {
    return this.verificationCodes.get(email);
  }

  clear(): void {
    this.otps.clear();
    this.verificationCodes.clear();
  }
}
