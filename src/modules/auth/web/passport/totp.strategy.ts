import type { Request } from 'express';
import { inject, injectable } from 'inversify';
import { Strategy as PassportStrategy } from 'passport-strategy';
import { MfaChallengeExpiredException } from '@/core/errors/domain.error.js';
import { AUTH_TYPES } from '@/modules/auth/auth.types.js';
import type { MfaService } from '@/modules/auth/logic/mfa.service.js';
import type { PassportStatic } from '@/modules/auth/web/passport/passport.provider.js';

interface MfaVerificationBody {
  code?: unknown;
  challengeToken?: unknown;
}

class TotpStrategy extends PassportStrategy {
  readonly name = 'totp';

  constructor(private readonly mfa: MfaService) {
    super();
  }

  override authenticate(req: Request): void {
    void this.handle(req);
  }

  private async handle(req: Request): Promise<void> {
    try {
      const body = this.readBody(req.body);
      const code = typeof body.code === 'string' ? body.code : null;
      const challengeToken = typeof body.challengeToken === 'string' ? body.challengeToken : null;

      if (!(code && challengeToken)) {
        throw new MfaChallengeExpiredException();
      }

      const user = await this.mfa.verifyChallenge(challengeToken, code);

      this.success(user);
    } catch (error) {
      this.error(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private readBody(body: unknown): MfaVerificationBody {
    return typeof body === 'object' && body !== null ? (body as MfaVerificationBody) : {};
  }
}

@injectable()
export class TotpStrategyConfigurer {
  constructor(@inject(AUTH_TYPES.MfaService) private readonly mfa: MfaService) {}

  register(passport: PassportStatic): void {
    passport.use(new TotpStrategy(this.mfa));
  }
}
