import { inject, injectable, multiInject } from 'inversify';
import { CORE_TYPES } from '@/core/container/core.types.js';
import { AUTH_TYPES } from '@/modules/auth/auth.types.js';
import type { AuthService } from '@/modules/auth/logic/auth.service.js';
import { SessionPrincipal } from '@/modules/auth/logic/entities/authenticated-user.js';
import type { LocalStrategyConfigurer } from '@/modules/auth/web/passport/local.strategy.js';
import type {
  PassportProvider,
  PassportStatic,
} from '@/modules/auth/web/passport/passport.provider.js';
import type { TotpStrategyConfigurer } from '@/modules/auth/web/passport/totp.strategy.js';

@injectable()
export class PassportConfigurer {
  constructor(
    @inject(CORE_TYPES.Passport) private readonly passport: PassportStatic,
    @inject(AUTH_TYPES.AuthService) private readonly auth: AuthService,
    @inject(AUTH_TYPES.LocalStrategy)
    private readonly localStrategy: LocalStrategyConfigurer,
    @inject(AUTH_TYPES.TotpStrategy)
    private readonly totpStrategy: TotpStrategyConfigurer,
    @multiInject(AUTH_TYPES.OAuthProvider)
    private readonly providers: PassportProvider[],
  ) {}

  async configure(): Promise<void> {
    this.localStrategy.register(this.passport);
    this.totpStrategy.register(this.passport);

    for (const provider of this.providers) {
      await provider.register(this.passport);
    }

    this.passport.serializeUser<SessionPrincipal>((user, done) => {
      done(null, new SessionPrincipal(user.id, user.sessionVersion));
    });

    this.passport.deserializeUser<SessionPrincipal>(async (principal, done) => {
      if (
        !principal ||
        typeof principal.id !== 'string' ||
        typeof principal.sessionVersion !== 'number'
      ) {
        done(null, false);
        return;
      }

      try {
        const user = await this.auth.findSessionUser(principal.id, principal.sessionVersion);

        done(null, user ?? false);
      } catch (error) {
        done(error);
      }
    });
  }
}
