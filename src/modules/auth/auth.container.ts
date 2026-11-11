import { Container } from 'inversify';
import type { PrincipalStore } from '@/core/auth/principal.store.js';
import { RequireBearerAuthMiddleware } from '@/core/auth/require-bearer-auth.middleware.js';
import type { AppConfig } from '@/core/config/app.config.js';
import { CORE_TYPES } from '@/core/container/core.types.js';
import { AuthRateLimiter } from '@/core/http/middleware/rate-limit.js';
import { RequestScopeMiddleware } from '@/core/http/middleware/request-scope.js';
import { AUTH_TYPES } from '@/modules/auth/auth.types.js';
import { AesMfaSecretCipher } from '@/modules/auth/data/aes-mfa-secret.cipher.js';
import { Argon2PasswordHasher } from '@/modules/auth/data/argon2-password.hasher.js';
import { LogEmailSender } from '@/modules/auth/data/email/log-email.sender.js';
import { SmtpEmailSender } from '@/modules/auth/data/email/smtp-email.sender.js';
import { PostgresMfaRepository } from '@/modules/auth/data/postgres-mfa.repository.js';
import { PostgresOAuthAccountRepository } from '@/modules/auth/data/postgres-oauth-account.repository.js';
import { PostgresPasswordResetRepository } from '@/modules/auth/data/postgres-password-reset.repository.js';
import { PostgresRefreshTokenRepository } from '@/modules/auth/data/postgres-refresh-token.repository.js';
import { PostgresUserRepository } from '@/modules/auth/data/postgres-user.repository.js';
import { RedisOAuthGrantStore } from '@/modules/auth/data/redis-oauth-grant.store.js';
import { RedisOAuthStateStore } from '@/modules/auth/data/redis-oauth-state.store.js';
import { TokenGenerator } from '@/modules/auth/data/token.generator.js';
import { AccountLockoutService } from '@/modules/auth/logic/account-lockout.service.js';
import { AuthService } from '@/modules/auth/logic/auth.service.js';
import { AuthPrincipalStore } from '@/modules/auth/logic/auth-principal.store.js';
import { MfaService } from '@/modules/auth/logic/mfa.service.js';
import { OAuthLoginService } from '@/modules/auth/logic/oauth-login.service.js';
import { PasswordResetService } from '@/modules/auth/logic/password-reset.service.js';
import type { EmailSender } from '@/modules/auth/logic/ports/email.sender.js';
import type { MfaRepository } from '@/modules/auth/logic/ports/mfa.repository.js';
import type { MfaSecretCipher } from '@/modules/auth/logic/ports/mfa-secret.cipher.js';
import type { OAuthAccountRepository } from '@/modules/auth/logic/ports/oauth-account.repository.js';
import type { OAuthGrantStore } from '@/modules/auth/logic/ports/oauth-grant.store.js';
import type { OAuthStateStore } from '@/modules/auth/logic/ports/oauth-state.store.js';
import type { PasswordHasher } from '@/modules/auth/logic/ports/password.hasher.js';
import type { PasswordResetRepository } from '@/modules/auth/logic/ports/password-reset.repository.js';
import type { RefreshTokenRepository } from '@/modules/auth/logic/ports/refresh-token.repository.js';
import type { UserRepository } from '@/modules/auth/logic/ports/user.repository.js';
import { TokenService } from '@/modules/auth/logic/token.service.js';
import { TotpService } from '@/modules/auth/logic/totp.service.js';
import { AuthController } from '@/modules/auth/web/auth.controller.js';
import { MfaController } from '@/modules/auth/web/mfa.controller.js';
import { OAuthController } from '@/modules/auth/web/oauth.controller.js';
import { GitHubPassportProvider } from '@/modules/auth/web/passport/github.strategy.js';
import { GooglePassportProvider } from '@/modules/auth/web/passport/google.strategy.js';
import { LocalStrategyConfigurer } from '@/modules/auth/web/passport/local.strategy.js';
import { OidcPassportProvider } from '@/modules/auth/web/passport/oidc.strategy.js';
import { PassportConfigurer } from '@/modules/auth/web/passport/passport.configurer.js';
import type { PassportProvider } from '@/modules/auth/web/passport/passport.provider.js';
import { PassportOAuthStateStore } from '@/modules/auth/web/passport/passport-oauth-state.store.js';
import { TotpStrategyConfigurer } from '@/modules/auth/web/passport/totp.strategy.js';
import { PasswordResetController } from '@/modules/auth/web/password-reset.controller.js';
import { AuthRouter } from '@/modules/auth/web/routes/auth.router.js';
import { OAuthRouter } from '@/modules/auth/web/routes/oauth.router.js';
import { TokenController } from '@/modules/auth/web/token.controller.js';

export class AuthContainer extends Container {
  constructor(
    /** The root container; the auth module publishes its public services into it. */
    private readonly root: Container,
    config: AppConfig,
  ) {
    super({ parent: root });

    this.bind<RequestScopeMiddleware>(AUTH_TYPES.RequestScope).toConstantValue(
      new RequestScopeMiddleware(this),
    );
    this.bind<AuthRateLimiter>(AUTH_TYPES.AuthRateLimiter).to(AuthRateLimiter).inSingletonScope();

    this.bind<UserRepository>(AUTH_TYPES.UserRepository)
      .to(PostgresUserRepository)
      .inSingletonScope();
    this.bind<OAuthAccountRepository>(AUTH_TYPES.OAuthAccountRepository)
      .to(PostgresOAuthAccountRepository)
      .inSingletonScope();
    this.bind<PasswordResetRepository>(AUTH_TYPES.PasswordResetRepository)
      .to(PostgresPasswordResetRepository)
      .inSingletonScope();
    this.bind<MfaRepository>(AUTH_TYPES.MfaRepository).to(PostgresMfaRepository).inSingletonScope();
    this.bind<RefreshTokenRepository>(AUTH_TYPES.RefreshTokenRepository)
      .to(PostgresRefreshTokenRepository)
      .inSingletonScope();
    this.bind<OAuthGrantStore>(AUTH_TYPES.OAuthGrantStore)
      .to(RedisOAuthGrantStore)
      .inSingletonScope();
    this.bind<OAuthStateStore>(AUTH_TYPES.OAuthStateStore)
      .to(RedisOAuthStateStore)
      .inSingletonScope();
    this.bind<PasswordHasher>(AUTH_TYPES.PasswordHasher)
      .to(Argon2PasswordHasher)
      .inSingletonScope();
    this.bind<MfaSecretCipher>(AUTH_TYPES.MfaSecretCipher)
      .to(AesMfaSecretCipher)
      .inSingletonScope();
    this.bind<TokenGenerator>(AUTH_TYPES.TokenGenerator).to(TokenGenerator).inSingletonScope();

    if (config.smtp.enabled) {
      this.bind<EmailSender>(AUTH_TYPES.EmailSender).to(SmtpEmailSender).inSingletonScope();
    } else {
      this.bind<EmailSender>(AUTH_TYPES.EmailSender).to(LogEmailSender).inSingletonScope();
    }

    this.bind<AccountLockoutService>(AUTH_TYPES.AccountLockoutService)
      .to(AccountLockoutService)
      .inSingletonScope();
    this.bind<AuthService>(AUTH_TYPES.AuthService).to(AuthService).inSingletonScope();
    this.bind<PasswordResetService>(AUTH_TYPES.PasswordResetService)
      .to(PasswordResetService)
      .inSingletonScope();
    this.bind<OAuthLoginService>(AUTH_TYPES.OAuthLoginService)
      .to(OAuthLoginService)
      .inSingletonScope();
    this.bind<TotpService>(AUTH_TYPES.TotpService).to(TotpService).inSingletonScope();
    this.bind<MfaService>(AUTH_TYPES.MfaService).to(MfaService).inSingletonScope();
    this.bind<TokenService>(AUTH_TYPES.TokenService).to(TokenService).inSingletonScope();
    this.bind<AuthPrincipalStore>(AUTH_TYPES.PrincipalStore)
      .to(AuthPrincipalStore)
      .inSingletonScope();

    this.bind<LocalStrategyConfigurer>(AUTH_TYPES.LocalStrategy)
      .to(LocalStrategyConfigurer)
      .inSingletonScope();
    this.bind<TotpStrategyConfigurer>(AUTH_TYPES.TotpStrategy)
      .to(TotpStrategyConfigurer)
      .inSingletonScope();
    this.bind<PassportOAuthStateStore>(AUTH_TYPES.PassportOAuthStateStore)
      .to(PassportOAuthStateStore)
      .inSingletonScope();

    if (config.github.enabled) {
      this.bind<PassportProvider>(AUTH_TYPES.OAuthProvider)
        .to(GitHubPassportProvider)
        .inSingletonScope();
    }

    if (config.google.enabled) {
      this.bind<PassportProvider>(AUTH_TYPES.OAuthProvider)
        .to(GooglePassportProvider)
        .inSingletonScope();
    }

    if (
      config.sso.enabled &&
      config.sso.issuer &&
      config.sso.clientId &&
      config.sso.clientSecret &&
      config.sso.callbackUrl
    ) {
      this.bind<PassportProvider>(AUTH_TYPES.OAuthProvider)
        .to(OidcPassportProvider)
        .inSingletonScope();
    }

    this.bind<PassportConfigurer>(AUTH_TYPES.PassportConfigurer)
      .to(PassportConfigurer)
      .inSingletonScope();

    this.bind<AuthController>(AUTH_TYPES.AuthController).to(AuthController);
    this.bind<TokenController>(AUTH_TYPES.TokenController).to(TokenController);
    this.bind<PasswordResetController>(AUTH_TYPES.PasswordResetController).to(
      PasswordResetController,
    );
    this.bind<MfaController>(AUTH_TYPES.MfaController).to(MfaController);
    this.bind<OAuthController>(AUTH_TYPES.OAuthController).to(OAuthController);

    this.bind<OAuthRouter>(AUTH_TYPES.OAuthRouter).to(OAuthRouter).inSingletonScope();
    this.bind<AuthRouter>(AUTH_TYPES.AuthRouter).to(AuthRouter).inSingletonScope();

    this.publishToRoot();
  }

  /**
   * Exports the auth module's public services into the root container.
   *
   * Every module can then resolve `CORE_TYPES.PrincipalStore` and
   * `CORE_TYPES.RequireAuth` without importing the auth module, which keeps
   * the module boundary one-directional: modules depend on `core` only.
   */
  private publishToRoot(): void {
    const principalStore = this.get<AuthPrincipalStore>(AUTH_TYPES.PrincipalStore);
    const middleware = new RequireBearerAuthMiddleware(
      this.get(CORE_TYPES.AccessTokenService),
      this.get(CORE_TYPES.AuthDenylist),
      principalStore,
    );

    this.root.bind<PrincipalStore>(CORE_TYPES.PrincipalStore).toConstantValue(principalStore);
    this.root.bind<RequireBearerAuthMiddleware>(CORE_TYPES.RequireAuth).toConstantValue(middleware);
  }
}
