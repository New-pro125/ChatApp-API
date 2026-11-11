import { inject, injectable, multiInject } from 'inversify';
import { CORE_TYPES } from '@/core/container/core.types.js';
import { AUTH_TYPES } from '@/modules/auth/auth.types.js';
import type { LocalStrategyConfigurer } from '@/modules/auth/web/passport/local.strategy.js';
import type {
  PassportProvider,
  PassportStatic,
} from '@/modules/auth/web/passport/passport.provider.js';
import type { TotpStrategyConfigurer } from '@/modules/auth/web/passport/totp.strategy.js';

/**
 * Registers the Passport strategies.
 *
 * Strategies run with `session: false`: authentication results are converted
 * into access/refresh token pairs instead of session cookies.
 */
@injectable()
export class PassportConfigurer {
  constructor(
    @inject(CORE_TYPES.Passport) private readonly passport: PassportStatic,
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
  }
}
