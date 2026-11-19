export const AUTH_TYPES = {
  UserRepository: Symbol.for('Auth.UserRepository'),
  OAuthAccountRepository: Symbol.for('Auth.OAuthAccountRepository'),
  PasswordResetRepository: Symbol.for('Auth.PasswordResetRepository'),
  EmailVerificationRepository: Symbol.for('Auth.EmailVerificationRepository'),
  MfaRepository: Symbol.for('Auth.MfaRepository'),
  RefreshTokenRepository: Symbol.for('Auth.RefreshTokenRepository'),
  UserPrivacyRepository: Symbol.for('Auth.UserPrivacyRepository'),
  ReadReceiptPreferenceService: Symbol.for('Auth.ReadReceiptPreferenceService'),
  UserBlockRepository: Symbol.for('Auth.UserBlockRepository'),
  OAuthGrantStore: Symbol.for('Auth.OAuthGrantStore'),
  OAuthStateStore: Symbol.for('Auth.OAuthStateStore'),
  PasswordHasher: Symbol.for('Auth.PasswordHasher'),
  MfaSecretCipher: Symbol.for('Auth.MfaSecretCipher'),
  EmailSender: Symbol.for('Auth.EmailSender'),
  CaptchaVerifier: Symbol.for('Auth.CaptchaVerifier'),

  AuthService: Symbol.for('Auth.AuthService'),
  AccountLockoutService: Symbol.for('Auth.AccountLockoutService'),
  PasswordResetService: Symbol.for('Auth.PasswordResetService'),
  EmailVerificationService: Symbol.for('Auth.EmailVerificationService'),
  CaptchaService: Symbol.for('Auth.CaptchaService'),
  OAuthLoginService: Symbol.for('Auth.OAuthLoginService'),
  MfaService: Symbol.for('Auth.MfaService'),
  TotpService: Symbol.for('Auth.TotpService'),
  TokenService: Symbol.for('Auth.TokenService'),
  ProfileService: Symbol.for('Auth.ProfileService'),
  PrivacyService: Symbol.for('Auth.PrivacyService'),
  BlockService: Symbol.for('Auth.BlockService'),
  PrincipalStore: Symbol.for('Auth.PrincipalStore'),
  TokenGenerator: Symbol.for('Auth.TokenGenerator'),

  AuthRateLimiter: Symbol.for('Auth.AuthRateLimiter'),
  ProfileRateLimiter: Symbol.for('Auth.ProfileRateLimiter'),
  AuthController: Symbol.for('Auth.AuthController'),
  TokenController: Symbol.for('Auth.TokenController'),
  PasswordResetController: Symbol.for('Auth.PasswordResetController'),
  EmailVerificationController: Symbol.for('Auth.EmailVerificationController'),
  MfaController: Symbol.for('Auth.MfaController'),
  OAuthController: Symbol.for('Auth.OAuthController'),
  ProfileController: Symbol.for('Auth.ProfileController'),
  PrivacyController: Symbol.for('Auth.PrivacyController'),
  BlockController: Symbol.for('Auth.BlockController'),
  OAuthRouter: Symbol.for('Auth.OAuthRouter'),
  AuthRouter: Symbol.for('Auth.AuthRouter'),

  PassportConfigurer: Symbol.for('Auth.PassportConfigurer'),
  LocalStrategy: Symbol.for('Auth.LocalStrategy'),
  TotpStrategy: Symbol.for('Auth.TotpStrategy'),
  PassportOAuthStateStore: Symbol.for('Auth.PassportOAuthStateStore'),
  OAuthProvider: Symbol.for('Auth.OAuthProvider'),
  RequestScope: Symbol.for('Auth.RequestScope'),
} as const;

export interface RegisterInput {
  email: string;
  displayName: string;
  password: string;
}

export interface VerifyOtpResult {
  resetToken: string;
  expiresAt: Date;
}
