import type { Profile as FacebookProfile } from 'passport-facebook';
import { describe, expect, it } from 'vitest';
import type { AppConfig } from '@/core/config/app.config.js';
import type { OAuthLoginService } from '@/modules/auth/logic/oauth-login.service.js';
import { FacebookPassportProvider } from '@/modules/auth/web/passport/facebook.strategy.js';
import type { PassportOAuthStateStore } from '@/modules/auth/web/passport/passport-oauth-state.store.js';

function createProvider(): FacebookPassportProvider {
  return new FacebookPassportProvider(
    {} as AppConfig,
    {} as OAuthLoginService,
    {} as PassportOAuthStateStore,
  );
}

function createProfile(overrides: Partial<FacebookProfile> = {}): FacebookProfile {
  return {
    provider: 'facebook',
    id: 'facebook-123',
    displayName: 'Meta User',
    birthday: '1990-01-01',
    _raw: '{}',
    _json: {},
    ...overrides,
  };
}

describe('FacebookPassportProvider', () => {
  it('maps a returned email and treats it as verified', () => {
    const profile = createProvider().toOAuthProfile(
      createProfile({ emails: [{ value: 'meta@example.com' }] }),
    );

    expect(profile.provider).toBe('facebook');
    expect(profile.providerAccountId).toBe('facebook-123');
    expect(profile.email).toBe('meta@example.com');
    expect(profile.emailVerified).toBe(true);
    expect(profile.displayName).toBe('Meta User');
  });

  it('passes a missing email through as unverified', () => {
    const profile = createProvider().toOAuthProfile(createProfile());

    expect(profile.email).toBeNull();
    expect(profile.emailVerified).toBe(false);
  });

  it('falls back to a display name when Facebook returns none', () => {
    const profile = createProvider().toOAuthProfile(createProfile({ displayName: '' }));

    expect(profile.displayName).toBe('Facebook User');
  });
});
