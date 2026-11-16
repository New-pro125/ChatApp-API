import { inject, injectable } from 'inversify';
import { type Profile as FacebookProfile, Strategy as FacebookStrategy } from 'passport-facebook';
import type { VerifyCallback } from 'passport-oauth2';
import type { AppConfig } from '@/core/config/app.config.js';
import { CORE_TYPES } from '@/core/container/core.types.js';
import { AUTH_TYPES } from '@/modules/auth/auth.types.js';
import { OAuthProfile } from '@/modules/auth/logic/entities/oauth-profile.js';
import type { OAuthLoginService } from '@/modules/auth/logic/oauth-login.service.js';
import type {
  PassportProvider,
  PassportStatic,
} from '@/modules/auth/web/passport/passport.provider.js';
import type { PassportOAuthStateStore } from '@/modules/auth/web/passport/passport-oauth-state.store.js';

@injectable()
export class FacebookPassportProvider implements PassportProvider {
  readonly name = 'facebook';
  readonly routePath = 'oauth/facebook';
  readonly scope = ['email'];

  constructor(
    @inject(CORE_TYPES.Config) private readonly config: AppConfig,
    @inject(AUTH_TYPES.OAuthLoginService)
    private readonly oauth: OAuthLoginService,
    @inject(AUTH_TYPES.PassportOAuthStateStore)
    private readonly stateStore: PassportOAuthStateStore,
  ) {}

  /**
   * Maps a Facebook profile to a provider-neutral OAuth profile.
   *
   * Facebook only returns an email when the user granted the `email` permission
   * and the account has one. It does not expose a per-email verification flag in
   * the profile, so a returned account email is treated as verified; a missing
   * email is passed through as unverified and rejected by `OAuthLoginService`.
   */
  toOAuthProfile(profile: FacebookProfile): OAuthProfile {
    const email = profile.emails?.[0]?.value ?? null;

    return new OAuthProfile(
      'facebook',
      profile.id,
      email,
      email !== null,
      profile.displayName || 'Facebook User',
    );
  }

  register(passport: PassportStatic): void {
    const settings = this.config.facebook.settings();

    passport.use(
      new FacebookStrategy(
        {
          clientID: settings.clientId,
          clientSecret: settings.clientSecret,
          callbackURL: settings.callbackUrl,
          profileFields: ['id', 'displayName', 'emails'],
          // passport-facebook defaults to the retired v3.2 Graph API, whose
          // profile endpoint no longer resolves. Pin a supported version.
          graphAPIVersion: 'v27.0',
          store: this.stateStore.asStateStore(),
        },
        async (
          _accessToken: string,
          _refreshToken: string,
          profile: FacebookProfile,
          done: VerifyCallback,
        ) => {
          try {
            const user = await this.oauth.resolve(this.toOAuthProfile(profile));

            done(null, user);
          } catch (error) {
            done(error as Error);
          }
        },
      ),
    );
  }
}
