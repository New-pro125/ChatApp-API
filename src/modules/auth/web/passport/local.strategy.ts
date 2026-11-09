import { inject, injectable } from 'inversify';
import LocalStrategy from 'passport-local';
import { AUTH_TYPES } from '@/modules/auth/auth.types.js';
import type { AuthService } from '@/modules/auth/logic/auth.service.js';
import type { PassportStatic } from '@/modules/auth/web/passport/passport.provider.js';

@injectable()
export class LocalStrategyConfigurer {
  constructor(@inject(AUTH_TYPES.AuthService) private readonly auth: AuthService) {}

  register(passport: PassportStatic): void {
    passport.use(
      new LocalStrategy(
        { usernameField: 'email', passwordField: 'password', passReqToCallback: true },
        async (req, email, password, done) => {
          try {
            const result = await this.auth.authenticate(email, password, req.ip ?? null);

            if (!result) {
              done(null, false, { message: 'Invalid email or password' });
              return;
            }

            if (result.status === 'mfa_required') {
              done(null, false, {
                message: 'Two-factor authentication is required',
                mfaRequired: true,
                challengeToken: result.challengeToken,
                expiresAt: result.expiresAt.toISOString(),
              });
              return;
            }

            done(null, result.user);
          } catch (error) {
            done(error);
          }
        },
      ),
    );
  }
}
