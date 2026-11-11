import type { Request, RequestHandler } from 'express';
import { inject, injectable } from 'inversify';
import type { AccessTokenClaims, AccessTokenService } from '@/core/auth/access-token.service.js';
import type { AuthDenylist } from '@/core/auth/auth-denylist.js';
import type { PrincipalStore } from '@/core/auth/principal.store.js';
import { CORE_TYPES } from '@/core/container/core.types.js';
import { InvalidAccessTokenException } from '@/core/errors/domain.error.js';
import { UnauthorizedException } from '@/core/errors/http.error.js';

/**
 * Authenticates requests from `Authorization: Bearer <jwt>` access tokens.
 *
 * The JWT is verified, checked against the revocation list, and matched with
 * the user's current session version, so password changes, global logout,
 * and bans take effect immediately instead of at token expiry.
 */
@injectable()
export class RequireBearerAuthMiddleware {
  constructor(
    @inject(CORE_TYPES.AccessTokenService) private readonly tokens: AccessTokenService,
    @inject(CORE_TYPES.AuthDenylist) private readonly denylist: AuthDenylist,
    @inject(CORE_TYPES.PrincipalStore) private readonly principals: PrincipalStore,
  ) {}

  readonly handle: RequestHandler = async (req, _res, next) => {
    try {
      const claims = await this.extractClaims(req);

      if (await this.denylist.isRevoked(claims)) {
        throw new InvalidAccessTokenException('Token has been revoked');
      }

      const principal = await this.principals.resolve(claims.userId, claims.sessionVersion);

      if (!principal) {
        throw new InvalidAccessTokenException('Session is no longer valid');
      }

      req.user = principal;
      req.auth = claims;

      next();
    } catch (error) {
      next(error);
    }
  };

  private extractClaims(req: Request): Promise<AccessTokenClaims> {
    const header = req.headers.authorization;

    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      throw new UnauthorizedException('A bearer access token is required');
    }

    return this.tokens.verify(header.slice('Bearer '.length).trim());
  }
}
