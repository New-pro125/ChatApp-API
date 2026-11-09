import { inject, injectable } from 'inversify';
import { type Profile as GoogleProfile, Strategy as GoogleStrategy } from 'passport-google-oauth20';
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

@injectable()
export class GooglePassportProvider implements PassportProvider {
  readonly name = 'google';
  readonly routePath = 'oauth/google';
  readonly scope = ['profile', 'email'];

  constructor(
    @inject(CORE_TYPES.Config) private readonly config: AppConfig,
    @inject(AUTH_TYPES.OAuthLoginService)
    private readonly oauth: OAuthLoginService,
  ) {}

  register(passport: PassportStatic): void {
    const settings = this.config.google.settings();

    passport.use(
      new GoogleStrategy(
        {
          clientID: settings.clientId,
          clientSecret: settings.clientSecret,
          callbackURL: settings.callbackUrl,
        },
        async (
          _accessToken: string,
          _refreshToken: string,
          profile: GoogleProfile,
          done: VerifyCallback,
        ) => {
          try {
            const email = profile.emails?.[0];

            const user = await this.oauth.resolve(
              new OAuthProfile(
                'google',
                profile.id,
                email?.value ?? null,
                email?.verified ?? false,
                profile.displayName || 'Google User',
              ),
            );

            done(null, user);
          } catch (error) {
            done(error as Error);
          }
        },
      ),
    );
  }
}
