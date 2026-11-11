import type { Request } from 'express';
import { inject, injectable } from 'inversify';
import * as client from 'openid-client';
import { Strategy as PassportStrategy } from 'passport-strategy';
import type { Logger } from 'pino';
import type { AppConfig } from '@/core/config/app.config.js';
import { CORE_TYPES } from '@/core/container/core.types.js';
import { AUTH_TYPES } from '@/modules/auth/auth.types.js';
import { OAuthProfile } from '@/modules/auth/logic/entities/oauth-profile.js';
import type { OAuthLoginService } from '@/modules/auth/logic/oauth-login.service.js';
import type { OAuthStateStore } from '@/modules/auth/logic/ports/oauth-state.store.js';
import type {
  PassportProvider,
  PassportStatic,
} from '@/modules/auth/web/passport/passport.provider.js';

interface OidcClaims {
  sub: string;
  email?: unknown;
  email_verified?: unknown;
  name?: unknown;
}

class OidcStrategy extends PassportStrategy {
  readonly name = 'sso';

  constructor(
    private readonly configuration: client.Configuration,
    private readonly oauth: OAuthLoginService,
    private readonly logger: Logger,
    private readonly states: OAuthStateStore,
    private readonly issuer: string,
    private readonly callbackUrl: string,
    private readonly scope: string,
  ) {
    super();
  }

  override authenticate(req: Request): void {
    void this.handle(req);
  }

  private async handle(req: Request): Promise<void> {
    try {
      const query = req.query as { code?: unknown };

      if (typeof query.code !== 'string') {
        await this.startAuthorization(req);
        return;
      }

      await this.completeAuthorization(req);
    } catch (error) {
      this.logger.error({ err: error }, 'OIDC authentication failed');
      this.error(error as Error);
    }
  }

  private async startAuthorization(req: Request): Promise<void> {
    const state = client.randomState();
    const codeVerifier = client.randomPKCECodeVerifier();
    const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);

    await this.states.save(req, { state, codeVerifier });

    const authorizationUrl = client.buildAuthorizationUrl(this.configuration, {
      redirect_uri: this.callbackUrl,
      scope: this.scope,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });

    this.redirect(authorizationUrl.href);
  }

  private async completeAuthorization(req: Request): Promise<void> {
    const saved = await this.states.consume(req);

    if (!(saved?.state && saved.codeVerifier)) {
      this.fail({ message: 'Missing OIDC request state' }, 401);
      return;
    }

    const currentUrl = new URL(req.originalUrl, this.callbackUrl);
    const tokens = await client.authorizationCodeGrant(this.configuration, currentUrl, {
      pkceCodeVerifier: saved.codeVerifier,
      expectedState: saved.state,
    });

    const claims = tokens.claims() as OidcClaims | undefined;

    if (!claims) {
      this.fail({ message: 'OIDC provider did not return an ID token' }, 401);
      return;
    }

    const email = typeof claims.email === 'string' ? claims.email : null;
    const emailVerified = claims.email_verified === true || claims.email_verified === 'true';
    const displayName = typeof claims.name === 'string' ? claims.name : (email ?? 'SSO User');

    const user = await this.oauth.resolve(
      new OAuthProfile(`oidc:${this.issuer}`, claims.sub, email, emailVerified, displayName),
    );

    this.success(user);
  }
}

@injectable()
export class OidcPassportProvider implements PassportProvider {
  readonly name = 'sso';
  readonly routePath = 'sso';
  readonly scope: string;

  constructor(
    @inject(CORE_TYPES.Config) private readonly config: AppConfig,
    @inject(AUTH_TYPES.OAuthLoginService)
    private readonly oauth: OAuthLoginService,
    @inject(AUTH_TYPES.OAuthStateStore) private readonly states: OAuthStateStore,
    @inject(CORE_TYPES.Logger) private readonly logger: Logger,
  ) {
    this.scope = config.sso.scopes;
  }

  async register(passport: PassportStatic): Promise<void> {
    const settings = this.config.sso.settings();
    const configuration = await client.discovery(
      new URL(settings.issuer),
      settings.clientId,
      settings.clientSecret,
    );

    passport.use(
      new OidcStrategy(
        configuration,
        this.oauth,
        this.logger,
        this.states,
        settings.issuer,
        settings.callbackUrl,
        settings.scopes,
      ),
    );
  }
}
