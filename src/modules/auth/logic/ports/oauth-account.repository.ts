import type { VerifiedOAuthProfile } from '@/modules/auth/logic/entities/oauth-profile.js';
import type { UserRecord } from '@/modules/auth/logic/entities/user-record.js';

export interface OAuthAccountRepository {
  resolve(profile: VerifiedOAuthProfile): Promise<UserRecord>;
}
