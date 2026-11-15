import type { RequestHandler } from 'express';
import { injectable } from 'inversify';
import { EmailNotVerifiedException } from '@/core/errors/domain.error.js';
import { UnauthorizedException } from '@/core/errors/http.error.js';

/**
 * Gating middleware: ensures the authenticated user has verified their email address.
 *
 * This protects messaging and uploads without preventing unverified users from
 * logging in, managing active sessions, or requesting verification emails.
 */
@injectable()
export class RequireVerifiedEmailMiddleware {
  readonly handle: RequestHandler = (req, _res, next) => {
    if (!req.user) {
      next(new UnauthorizedException('Authentication is required'));
      return;
    }

    if (!req.user.emailVerifiedAt) {
      next(new EmailNotVerifiedException());
      return;
    }

    next();
  };
}
