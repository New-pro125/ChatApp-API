import type { Container } from 'inversify';
import type { AccessTokenClaims } from '@/core/auth/access-token.service.js';
import type { AuthenticatedUser } from '@/modules/auth/logic/entities/authenticated-user.js';

declare global {
  namespace Express {
    interface User extends AuthenticatedUser {}

    interface Request {
      requestId: string;
      container: Container;
      /** Claims from the verified bearer access token, set by `RequireBearerAuthMiddleware`. */
      auth?: AccessTokenClaims;
    }
  }
}
