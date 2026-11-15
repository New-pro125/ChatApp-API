export interface EmailSender {
  sendOtp(email: string, otp: string, expiresAt: Date): Promise<void>;
  sendVerificationCode(email: string, code: string, expiresAt: Date): Promise<void>;
}
