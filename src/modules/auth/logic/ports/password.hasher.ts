export interface PasswordHasher {
  hash(plain: string): Promise<string>;
  verify(digest: string, plain: string): Promise<boolean>;
  verifyDummy(plain: string): Promise<void>;
}
