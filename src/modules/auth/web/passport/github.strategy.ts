import { inject, injectable } from 'inversify';
import { type Profile as GitHubProfile, Strategy as GitHubStrategy } from 'passport-github2';
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
export class GitHubPassportProvider implements PassportProvider {
  readonly name = 'github';
  readonly routePath = 'oauth/github';
  readonly scope = ['user:email'];

  constructor(
    @inject(CORE_TYPES.Config) private readonly config: AppConfig,
    @inject(AUTH_TYPES.OAuthLoginService)
    private readonly oauth: OAuthLoginService,
  ) {}

  register(passport: PassportStatic): void {
    const settings = this.config.github.settings();

    passport.use(
      new GitHubStrategy(
        {
          clientID: settings.clientId,
          clientSecret: settings.clientSecret,
          callbackURL: settings.callbackUrl,
          allRawEmails: true,
        },
        async (
          _accessToken: string,
          _refreshToken: string,
          profile: GitHubProfile,
          done: VerifyCallback,
        ) => {
          try {
            const emails = profile.emails as
              | { value: string; primary?: boolean; verified?: boolean }[]
              | undefined;
            const email = emails?.find((candidate) => candidate.primary) ?? emails?.[0];

            const user = await this.oauth.resolve(
              new OAuthProfile(
                'github',
                profile.id,
                email?.value ?? null,
                email?.verified === true,
                profile.displayName || profile.username || 'GitHub User',
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
