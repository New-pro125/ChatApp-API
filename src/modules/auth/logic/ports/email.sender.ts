export interface EmailSender {
  sendOtp(email: string, otp: string, expiresAt: Date): Promise<void>;
}
