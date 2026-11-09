export interface MfaSecretCipher {
  encrypt(secret: string): string;
  decrypt(ciphertext: string): string;
}
