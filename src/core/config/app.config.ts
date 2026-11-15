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
    readonly timeoutMs: number,
  ) {
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new Error('SMTP_TIMEOUT_MS must be a positive integer');
    }
  }

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

export class EmailVerificationConfig {
  constructor(
    readonly ttlSeconds: number,
    readonly maxAttempts: number,
    readonly resendCooldownSeconds: number,
  ) {
    if (!Number.isInteger(this.ttlSeconds) || this.ttlSeconds <= 0) {
      throw new Error('EMAIL_VERIFICATION_TTL_SECONDS must be a positive integer');
    }

    if (!Number.isInteger(this.maxAttempts) || this.maxAttempts < 1) {
      throw new Error('EMAIL_VERIFICATION_MAX_ATTEMPTS must be a positive integer');
    }

    if (!Number.isInteger(this.resendCooldownSeconds) || this.resendCooldownSeconds < 0) {
      throw new Error('EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS must be zero or greater');
    }
  }
}

export class CaptchaConfig {
  constructor(
    readonly enabled: boolean,
    readonly secret: string | null,
    readonly verifyUrl: string,
    readonly timeoutMs: number,
    readonly expectedHostname: string | null,
    readonly expectedAction: string | null,
  ) {
    if (this.enabled && !this.secret) {
      throw new Error('CAPTCHA_SECRET is required when CAPTCHA_ENABLED=true');
    }

    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new Error('CAPTCHA_TIMEOUT_MS must be a positive integer');
    }
  }
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

export class TokenConfig {
  /** Ed25519 private key seed; null means an ephemeral key is generated. */
  readonly privateKeySeed: Buffer | null;
  readonly issuer: string;
  readonly audience: string;
  readonly accessTokenTtlSeconds: number;
  readonly refreshTokenTtlSeconds: number;
  readonly oauthGrantTtlSeconds: number;
  readonly oauthStateTtlSeconds: number;
  readonly oauthStateCookieName: string;

  constructor(
    privateKeySeed: Buffer | null,
    issuer: string,
    audience: string,
    accessTokenTtlSeconds: number,
    refreshTokenTtlSeconds: number,
    oauthGrantTtlSeconds: number,
    oauthStateTtlSeconds: number,
    oauthStateCookieName: string,
    requireProductionKey: boolean,
  ) {
    if (requireProductionKey && privateKeySeed === null) {
      throw new Error(
        'ACCESS_TOKEN_PRIVATE_KEY is required in production: a base64url-encoded 32-byte Ed25519 seed',
      );
    }

    if (privateKeySeed !== null && privateKeySeed.length !== 32) {
      throw new Error('ACCESS_TOKEN_PRIVATE_KEY must decode to exactly 32 bytes');
    }

    if (accessTokenTtlSeconds <= 0 || refreshTokenTtlSeconds <= accessTokenTtlSeconds) {
      throw new Error('Token TTLs must be positive and the refresh TTL must exceed the access TTL');
    }

    this.privateKeySeed = privateKeySeed;
    this.issuer = issuer;
    this.audience = audience;
    this.accessTokenTtlSeconds = accessTokenTtlSeconds;
    this.refreshTokenTtlSeconds = refreshTokenTtlSeconds;
    this.oauthGrantTtlSeconds = oauthGrantTtlSeconds;
    this.oauthStateTtlSeconds = oauthStateTtlSeconds;
    this.oauthStateCookieName = oauthStateCookieName;
  }
}

export class HttpConfig {
  constructor(
    readonly bodyLimitBytes: number,
    readonly requestTimeoutMs: number,
    readonly headersTimeoutMs: number,
    readonly keepAliveTimeoutMs: number,
    readonly connectionsCheckingIntervalMs: number,
    readonly maxRequestsPerSocket: number,
    readonly maxHeaderSizeBytes: number,
    readonly shutdownTimeoutMs: number,
    readonly compressionThresholdBytes: number,
    readonly metricsEnabled: boolean,
    readonly metricsToken: string | undefined,
    readonly healthCacheTtlMs: number,
    readonly trustProxy: boolean | number | string,
    readonly corsOrigins: readonly string[],
  ) {
    if (this.headersTimeoutMs > this.requestTimeoutMs) {
      throw new Error(
        'HTTP_HEADERS_TIMEOUT_MS must be less than or equal to HTTP_REQUEST_TIMEOUT_MS',
      );
    }

    if (this.keepAliveTimeoutMs >= this.headersTimeoutMs) {
      throw new Error('HTTP_HEADERS_TIMEOUT_MS must be greater than HTTP_KEEP_ALIVE_TIMEOUT_MS');
    }
  }
}

export class AppConfig {
  readonly nodeEnv: NodeEnvironment;
  readonly port: number;
  readonly appOrigin: string;
  readonly docsEnabled: boolean;
  readonly http: HttpConfig;

  readonly databaseUrl: string;
  readonly databasePoolMax: number;
  readonly databaseStatementTimeoutMs: number;
  readonly databaseIdleTimeoutMs: number;
  readonly databaseConnectionTimeoutMs: number;
  readonly redisUrl: string;

  readonly tokens: TokenConfig;

  readonly logLevel: LogLevel;

  readonly lockout: LockoutConfig;
  readonly otp: OtpConfig;
  readonly verification: EmailVerificationConfig;
  readonly captcha: CaptchaConfig;
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

    this.http = new HttpConfig(
      env.readNumber('HTTP_BODY_LIMIT_BYTES', 262_144),
      env.readNumber('HTTP_REQUEST_TIMEOUT_MS', 300_000),
      env.readNumber('HTTP_HEADERS_TIMEOUT_MS', 66_000),
      env.readNumber('HTTP_KEEP_ALIVE_TIMEOUT_MS', 65_000),
      env.readNumber('HTTP_CONNECTIONS_CHECK_INTERVAL_MS', 30_000),
      env.readNumber('HTTP_MAX_REQUESTS_PER_SOCKET', 1_000),
      env.readNumber('HTTP_MAX_HEADER_SIZE_BYTES', 16_384),
      env.readNumber('HTTP_SHUTDOWN_TIMEOUT_MS', 15_000),
      env.readNumber('HTTP_COMPRESSION_THRESHOLD_BYTES', 1_024),
      env.readBoolean('METRICS_ENABLED', this.nodeEnv !== 'production'),
      env.readOptional('METRICS_TOKEN'),
      env.readNumber('HEALTH_CACHE_TTL_MS', 5_000),
      this.parseTrustProxy(env.readString('TRUST_PROXY', 'false')),
      this.parseOrigins(env.readString('APP_ORIGINS', this.appOrigin)),
    );

    this.databaseUrl = env.readRequired('DATABASE_URL');
    this.databasePoolMax = env.readNumber('DB_POOL_MAX', 10);
    this.databaseStatementTimeoutMs = env.readNumber('DB_STATEMENT_TIMEOUT_MS', 5000);
    this.databaseIdleTimeoutMs = env.readNumber('DB_IDLE_TIMEOUT_MS', 30000);
    this.databaseConnectionTimeoutMs = env.readNumber('DB_CONNECTION_TIMEOUT_MS', 5000);
    this.redisUrl = env.readRequired('REDIS_URL');

    const accessTokenPrivateKey = env.readOptional('ACCESS_TOKEN_PRIVATE_KEY');

    this.tokens = new TokenConfig(
      accessTokenPrivateKey === undefined ? null : Buffer.from(accessTokenPrivateKey, 'base64url'),
      env.readString('ACCESS_TOKEN_ISSUER', 'inversify-messenger'),
      env.readString('ACCESS_TOKEN_AUDIENCE', 'inversify-messenger'),
      env.readNumber('ACCESS_TOKEN_TTL_SECONDS', 900),
      env.readNumber('REFRESH_TOKEN_TTL_SECONDS', 2_592_000),
      env.readNumber('OAUTH_GRANT_TTL_SECONDS', 60),
      env.readNumber('OAUTH_STATE_TTL_SECONDS', 600),
      env.readString('OAUTH_STATE_COOKIE_NAME', 'inversify.oauth'),
      this.nodeEnv === 'production',
    );

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

    this.verification = new EmailVerificationConfig(
      env.readNumber('EMAIL_VERIFICATION_TTL_SECONDS', 86_400),
      env.readNumber('EMAIL_VERIFICATION_MAX_ATTEMPTS', 5),
      env.readNumber('EMAIL_VERIFICATION_RESEND_COOLDOWN_SECONDS', 60),
    );

    this.captcha = new CaptchaConfig(
      env.readBoolean('CAPTCHA_ENABLED', false),
      env.readOptional('CAPTCHA_SECRET') ?? null,
      env.readString(
        'CAPTCHA_VERIFY_URL',
        'https://challenges.cloudflare.com/turnstile/v0/siteverify',
      ),
      env.readNumber('CAPTCHA_TIMEOUT_MS', 5_000),
      env.readOptional('CAPTCHA_EXPECTED_HOSTNAME') ?? null,
      env.readOptional('CAPTCHA_EXPECTED_ACTION') ?? null,
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
      env.readNumber('SMTP_TIMEOUT_MS', 10_000),
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

  private parseTrustProxy(raw: string): boolean | number | string {
    if (raw === 'true') {
      return 1;
    }

    if (raw === 'false') {
      return false;
    }

    const hops = Number(raw);

    return Number.isInteger(hops) && hops >= 0 ? hops : raw;
  }

  private parseOrigins(raw: string): readonly string[] {
    const seen = new Set<string>();
    const origins: string[] = [];

    for (const part of raw.split(',')) {
      const origin = part.trim();

      if (origin.length > 0 && !seen.has(origin)) {
        seen.add(origin);
        origins.push(origin);
      }
    }

    return origins;
  }
}
