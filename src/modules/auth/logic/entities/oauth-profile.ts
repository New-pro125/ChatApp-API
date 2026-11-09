export class OAuthProfile {
  constructor(
    readonly provider: string,
    readonly providerAccountId: string,
    readonly email: string | null,
    readonly emailVerified: boolean,
    readonly displayName: string,
  ) {}
}

/** An OAuth profile whose email is present and verified by the provider. */
export type VerifiedOAuthProfile = OAuthProfile & { readonly email: string };
