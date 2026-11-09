export const AUTH_TYPES = {
  UserRepository: Symbol.for('Auth.UserRepository'),
  OAuthAccountRepository: Symbol.for('Auth.OAuthAccountRepository'),
  PasswordResetRepository: Symbol.for('Auth.PasswordResetRepository'),
  MfaRepository: Symbol.for('Auth.MfaRepository'),
  PasswordHasher: Symbol.for('Auth.PasswordHasher'),
  MfaSecretCipher: Symbol.for('Auth.MfaSecretCipher'),
  EmailSender: Symbol.for('Auth.EmailSender'),

  AuthService: Symbol.for('Auth.AuthService'),
  AccountLockoutService: Symbol.for('Auth.AccountLockoutService'),
  PasswordResetService: Symbol.for('Auth.PasswordResetService'),
  OAuthLoginService: Symbol.for('Auth.OAuthLoginService'),
  MfaService: Symbol.for('Auth.MfaService'),
  TotpService: Symbol.for('Auth.TotpService'),
  SessionManager: Symbol.for('Auth.SessionManager'),
  TokenGenerator: Symbol.for('Auth.TokenGenerator'),

  AuthRateLimiter: Symbol.for('Auth.AuthRateLimiter'),
  AuthController: Symbol.for('Auth.AuthController'),
  PasswordResetController: Symbol.for('Auth.PasswordResetController'),
  MfaController: Symbol.for('Auth.MfaController'),
  OAuthController: Symbol.for('Auth.OAuthController'),
  OAuthRouter: Symbol.for('Auth.OAuthRouter'),
  AuthRouter: Symbol.for('Auth.AuthRouter'),

  PassportConfigurer: Symbol.for('Auth.PassportConfigurer'),
  LocalStrategy: Symbol.for('Auth.LocalStrategy'),
  TotpStrategy: Symbol.for('Auth.TotpStrategy'),
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
