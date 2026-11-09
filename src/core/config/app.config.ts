import 'dotenv/config';
import { EnvironmentReader } from '@/core/config/environment.reader.js';

export type NodeEnvironment = 'development' | 'test' | 'production';
export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';

const NODE_ENVIRONMENTS: readonly NodeEnvironment[] = ['development', 'test', 'production'];
const LOG_LEVELS: readonly LogLevel[] = [
  'fatal',
  'error',
  'warn',
  'info',
  'debug',
  'trace',
  'silent',
];

export interface OAuthProviderSettings {
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
}

export class OAuthProviderConfig {
  constructor(
    readonly name: string,
    readonly clientId: string | undefined,
    readonly clientSecret: string | undefined,
    readonly callbackUrl: string | undefined,
  ) {}

  get enabled(): boolean {
    return Boolean(this.clientId && this.clientSecret && this.callbackUrl);
  }

  settings(): OAuthProviderSettings {
    if (!(this.clientId && this.clientSecret && this.callbackUrl)) {
      throw new Error(`OAuth provider "${this.name}" is not fully configured`);
    }

    return {
      clientId: this.clientId,
      clientSecret: this.clientSecret,
      callbackUrl: this.callbackUrl,
    };
  }
}

export class SmtpConfig {
  constructor(
    readonly host: string | undefined,
    readonly port: number,
    readonly secure: boolean,
    readonly user: string | undefined,
    readonly pass: string | undefined,
    readonly from: string,
  ) {}

  get enabled(): boolean {
    return Boolean(this.host);
  }
}

export class LockoutConfig {
  constructor(
    readonly maxAttempts: number,
    readonly windowSeconds: number,
    readonly lockoutSeconds: number,
  ) {}
}

export class OtpConfig {
  constructor(
    readonly ttlSeconds: number,
    readonly maxAttempts: number,
    readonly resendCooldownSeconds: number,
    readonly resetTokenTtlSeconds: number,
  ) {}
}

export class MfaConfig {
  constructor(
    readonly enabled: boolean,
    readonly issuer: string,
    readonly encryptionKey: Buffer | null,
    readonly totpWindow: number,
    readonly challengeTtlSeconds: number,
    readonly challengeMaxAttempts: number,
    readonly enrollmentTtlSeconds: number,
    readonly recoveryCodeCount: number,
  ) {
    if (this.enabled && this.encryptionKey?.length !== 32) {
      throw new Error(
        'MFA_ENCRYPTION_KEY must be a base64url-encoded 32-byte key when MFA is enabled',
      );
    }
  }

  requireEncryptionKey(): Buffer {
    if (!this.encryptionKey) {
      throw new Error('MFA encryption is not configured');
    }

    return this.encryptionKey;
  }
}

export interface SsoSettings {
  issuer: string;
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
  scopes: string;
}

export class SsoConfig {
  constructor(
    readonly enabled: boolean,
    readonly issuer: string | undefined,
    readonly clientId: string | undefined,
    readonly clientSecret: string | undefined,
    readonly callbackUrl: string | undefined,
    readonly scopes: string,
  ) {}

  settings(): SsoSettings {
    if (!(this.issuer && this.clientId && this.clientSecret && this.callbackUrl)) {
      throw new Error('OIDC SSO is not fully configured');
    }

    return {
      issuer: this.issuer,
      clientId: this.clientId,
      clientSecret: this.clientSecret,
      callbackUrl: this.callbackUrl,
      scopes: this.scopes,
    };
  }
}

export class AppConfig {
  readonly nodeEnv: NodeEnvironment;
  readonly port: number;
  readonly appOrigin: string;
  readonly docsEnabled: boolean;

  readonly databaseUrl: string;
  readonly databasePoolMax: number;
  readonly databaseStatementTimeoutMs: number;
  readonly databaseIdleTimeoutMs: number;
  readonly databaseConnectionTimeoutMs: number;
  readonly redisUrl: string;

  readonly sessionSecret: string;
  readonly sessionCookieName: string;
  readonly sessionTtlSeconds: number;

  readonly logLevel: LogLevel;

  readonly lockout: LockoutConfig;
  readonly otp: OtpConfig;
  readonly mfa: MfaConfig;
  readonly smtp: SmtpConfig;

  readonly github: OAuthProviderConfig;
  readonly google: OAuthProviderConfig;
  readonly sso: SsoConfig;

  readonly oauthSuccessRedirect: string;
  readonly oauthFailureRedirect: string;
  readonly oauthMfaRedirect: string;

  constructor() {
    const env = new EnvironmentReader();

    this.nodeEnv = env.readEnum('NODE_ENV', NODE_ENVIRONMENTS, 'development');
    this.port = env.readNumber('PORT', 4000);
    this.appOrigin = env.readString('APP_ORIGIN', 'http://localhost:5173');
    this.docsEnabled = env.readBoolean('DOCS_ENABLED', this.nodeEnv !== 'production');

    this.databaseUrl = env.readRequired('DATABASE_URL');
    this.databasePoolMax = env.readNumber('DB_POOL_MAX', 10);
    this.databaseStatementTimeoutMs = env.readNumber('DB_STATEMENT_TIMEOUT_MS', 5000);
    this.databaseIdleTimeoutMs = env.readNumber('DB_IDLE_TIMEOUT_MS', 30000);
    this.databaseConnectionTimeoutMs = env.readNumber('DB_CONNECTION_TIMEOUT_MS', 5000);
    this.redisUrl = env.readRequired('REDIS_URL');

    this.sessionSecret = env.readRequired('SESSION_SECRET');

    if (this.sessionSecret.length < 32) {
      throw new Error('SESSION_SECRET must be at least 32 characters long');
    }

    this.sessionCookieName = env.readString('SESSION_COOKIE_NAME', 'inversify.sid');
    this.sessionTtlSeconds = env.readNumber('SESSION_TTL_SECONDS', 604800);

    this.logLevel = env.readEnum('LOG_LEVEL', LOG_LEVELS, 'info');

    this.lockout = new LockoutConfig(
      env.readNumber('AUTH_MAX_FAILED_ATTEMPTS', 5),
      env.readNumber('AUTH_LOCKOUT_WINDOW_SECONDS', 900),
      env.readNumber('AUTH_LOCKOUT_SECONDS', 900),
    );

    this.otp = new OtpConfig(
      env.readNumber('OTP_TTL_SECONDS', 600),
      env.readNumber('OTP_MAX_ATTEMPTS', 5),
      env.readNumber('OTP_RESEND_COOLDOWN_SECONDS', 60),
      env.readNumber('OTP_RESET_TOKEN_TTL_SECONDS', 600),
    );

    const mfaEncryptionKey = env.readOptional('MFA_ENCRYPTION_KEY');

    this.mfa = new MfaConfig(
      env.readBoolean('MFA_ENABLED', true),
      env.readString('MFA_ISSUER', 'inversify-passport'),
      mfaEncryptionKey === undefined ? null : Buffer.from(mfaEncryptionKey, 'base64url'),
      env.readNumber('MFA_TOTP_WINDOW', 1),
      env.readNumber('MFA_CHALLENGE_TTL_SECONDS', 300),
      env.readNumber('MFA_CHALLENGE_MAX_ATTEMPTS', 5),
      env.readNumber('MFA_ENROLLMENT_TTL_SECONDS', 600),
      env.readNumber('MFA_RECOVERY_CODE_COUNT', 10),
    );

    this.smtp = new SmtpConfig(
      env.readOptional('SMTP_HOST'),
      env.readNumber('SMTP_PORT', 587),
      env.readBoolean('SMTP_SECURE', false),
      env.readOptional('SMTP_USER'),
      env.readOptional('SMTP_PASS'),
      env.readString('SMTP_FROM', 'no-reply@example.com'),
    );

    this.github = new OAuthProviderConfig(
      'github',
      env.readOptional('GITHUB_CLIENT_ID'),
      env.readOptional('GITHUB_CLIENT_SECRET'),
      env.readOptional('GITHUB_CALLBACK_URL'),
    );

    this.google = new OAuthProviderConfig(
      'google',
      env.readOptional('GOOGLE_CLIENT_ID'),
      env.readOptional('GOOGLE_CLIENT_SECRET'),
      env.readOptional('GOOGLE_CALLBACK_URL'),
    );

    this.sso = new SsoConfig(
      env.readBoolean('SSO_ENABLED', false),
      env.readOptional('SSO_ISSUER'),
      env.readOptional('SSO_CLIENT_ID'),
      env.readOptional('SSO_CLIENT_SECRET'),
      env.readOptional('SSO_CALLBACK_URL'),
      env.readString('SSO_SCOPES', 'openid profile email'),
    );

    this.oauthSuccessRedirect = env.readString(
      'OAUTH_SUCCESS_REDIRECT',
      `${this.appOrigin}/auth/callback`,
    );
    this.oauthFailureRedirect = env.readString(
      'OAUTH_FAILURE_REDIRECT',
      `${this.appOrigin}/auth/error`,
    );
    this.oauthMfaRedirect = env.readString('OAUTH_MFA_REDIRECT', `${this.appOrigin}/auth/mfa`);
  }
}
