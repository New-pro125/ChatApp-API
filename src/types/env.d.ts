export {};

declare global {
  namespace NodeJS {
    interface ProcessEnv {
      NODE_ENV?: 'development' | 'test' | 'production';
      PORT?: string;
      APP_ORIGIN?: string;

      DATABASE_URL?: string;
      REDIS_URL?: string;

      ACCESS_TOKEN_PRIVATE_KEY?: string;
      ACCESS_TOKEN_ISSUER?: string;
      ACCESS_TOKEN_AUDIENCE?: string;
      ACCESS_TOKEN_TTL_SECONDS?: string;
      REFRESH_TOKEN_TTL_SECONDS?: string;
      OAUTH_GRANT_TTL_SECONDS?: string;
      OAUTH_STATE_TTL_SECONDS?: string;
      OAUTH_STATE_COOKIE_NAME?: string;

      LOG_LEVEL?: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';

      AUTH_MAX_FAILED_ATTEMPTS?: string;
      AUTH_LOCKOUT_WINDOW_SECONDS?: string;
      AUTH_LOCKOUT_SECONDS?: string;

      OTP_TTL_SECONDS?: string;
      OTP_MAX_ATTEMPTS?: string;
      OTP_RESEND_COOLDOWN_SECONDS?: string;
      OTP_RESET_TOKEN_TTL_SECONDS?: string;

      MFA_ENABLED?: string;
      MFA_ISSUER?: string;
      MFA_ENCRYPTION_KEY?: string;
      MFA_TOTP_WINDOW?: string;
      MFA_CHALLENGE_TTL_SECONDS?: string;
      MFA_CHALLENGE_MAX_ATTEMPTS?: string;
      MFA_ENROLLMENT_TTL_SECONDS?: string;
      MFA_RECOVERY_CODE_COUNT?: string;

      MEDIA_BUCKET?: string;
      MEDIA_REGION?: string;
      MEDIA_ENDPOINT?: string;
      MEDIA_ACCESS_KEY_ID?: string;
      MEDIA_SECRET_ACCESS_KEY?: string;
      MEDIA_FORCE_PATH_STYLE?: string;
      MEDIA_MAX_BYTES?: string;
      MEDIA_ALLOWED_CONTENT_TYPES?: string;
      MEDIA_PRESIGN_TTL_SECONDS?: string;
      MEDIA_SCAN_REQUIRED?: string;

      CLAMAV_HOST?: string;
      CLAMAV_PORT?: string;
      CLAMAV_TIMEOUT_MS?: string;

      SMTP_HOST?: string;
      SMTP_PORT?: string;
      SMTP_SECURE?: string;
      SMTP_USER?: string;
      SMTP_PASS?: string;
      SMTP_FROM?: string;

      GITHUB_CLIENT_ID?: string;
      GITHUB_CLIENT_SECRET?: string;
      GITHUB_CALLBACK_URL?: string;

      GOOGLE_CLIENT_ID?: string;
      GOOGLE_CLIENT_SECRET?: string;
      GOOGLE_CALLBACK_URL?: string;

      OAUTH_SUCCESS_REDIRECT?: string;
      OAUTH_FAILURE_REDIRECT?: string;
      OAUTH_MFA_REDIRECT?: string;

      SSO_ENABLED?: string;
      SSO_ISSUER?: string;
      SSO_CLIENT_ID?: string;
      SSO_CLIENT_SECRET?: string;
      SSO_CALLBACK_URL?: string;
      SSO_SCOPES?: string;

      POSTGRES_DB?: string;
      POSTGRES_USER?: string;
      POSTGRES_PASSWORD?: string;
      POSTGRES_HOST_PORT?: string;
      REDIS_HOST_PORT?: string;
      API_HOST_PORT?: string;
      ADMINER_HOST_PORT?: string;
      REDISINSIGHT_HOST_PORT?: string;
      MAILPIT_SMTP_HOST_PORT?: string;
      MAILPIT_UI_HOST_PORT?: string;
    }
  }
}
