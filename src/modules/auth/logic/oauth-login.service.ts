import { inject, injectable } from 'inversify';
import { OAuthFailedException } from '@/core/errors/domain.error.js';
import { AUTH_TYPES } from '@/modules/auth/auth.types.js';
import { AuthenticatedUser } from '@/modules/auth/logic/entities/authenticated-user.js';
import type {
  OAuthProfile,
  VerifiedOAuthProfile,
} from '@/modules/auth/logic/entities/oauth-profile.js';
import type { OAuthAccountRepository } from '@/modules/auth/logic/ports/oauth-account.repository.js';

@injectable()
export class OAuthLoginService {
  constructor(
    @inject(AUTH_TYPES.OAuthAccountRepository)
    private readonly accounts: OAuthAccountRepository,
  ) {}

  async resolve(profile: OAuthProfile): Promise<AuthenticatedUser> {
    const user = await this.accounts.resolve(this.requireVerifiedEmail(profile));

    return AuthenticatedUser.fromRecord(user);
  }

  private requireVerifiedEmail(profile: OAuthProfile): VerifiedOAuthProfile {
    if (!(profile.email && profile.emailVerified)) {
      throw new OAuthFailedException(
        'The identity provider did not return a verified email address',
      );
    }

    return profile as VerifiedOAuthProfile;
  }
}
