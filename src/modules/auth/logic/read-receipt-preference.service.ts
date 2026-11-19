import { inject, injectable } from 'inversify';
import type { ReadReceiptPreferenceReader } from '@/core/privacy/read-receipt-preference.reader.js';
import { AUTH_TYPES } from '@/modules/auth/auth.types.js';
import type { PrivacyService } from '@/modules/auth/logic/privacy.service.js';

/** Answers the mutual read-receipt question from auth-owned privacy settings. */
@injectable()
export class ReadReceiptPreferenceService implements ReadReceiptPreferenceReader {
  constructor(@inject(AUTH_TYPES.PrivacyService) private readonly privacy: PrivacyService) {}

  async areEnabledForPair(firstUserId: string, secondUserId: string): Promise<boolean> {
    const [first, second] = await Promise.all([
      this.privacy.get(firstUserId),
      this.privacy.get(secondUserId),
    ]);

    return first.readReceiptsEnabled && second.readReceiptsEnabled;
  }
}
