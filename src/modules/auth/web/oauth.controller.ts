import type { Request, RequestHandler, Response } from 'express';
import { inject, injectable } from 'inversify';
import type { AppConfig } from '@/core/config/app.config.js';
import { CORE_TYPES } from '@/core/container/core.types.js';
import { OAuthFailedException } from '@/core/errors/domain.error.js';
import type { ApiResponse } from '@/core/http/response/api-response.js';
import { AUTH_TYPES } from '@/modules/auth/auth.types.js';
import type { MfaService } from '@/modules/auth/logic/mfa.service.js';
import type { SessionManager } from '@/modules/auth/logic/session-manager.js';

@injectable()
export class OAuthController {
  constructor(
    @inject(AUTH_TYPES.SessionManager) private readonly session: SessionManager,
    @inject(AUTH_TYPES.MfaService) private readonly mfa: MfaService,
    @inject(CORE_TYPES.Config) private readonly config: AppConfig,
    @inject(CORE_TYPES.ApiResponse) private readonly response: ApiResponse,
  ) {}

  complete: RequestHandler = async (req, res, next) => {
    try {
      if (!req.user) {
        next(new OAuthFailedException());
        return;
      }

      if (this.mfa.isAvailable() && req.user.mfaEnabled) {
        await this.requireMfa(req, res);
        return;
      }

      await this.session.establish(req, req.user);

      if (req.accepts(['json', 'html']) === 'json') {
        this.response.ok(res, req.user);
        return;
      }

      res.redirect(this.config.oauthSuccessRedirect);
    } catch (error) {
      next(error);
    }
  };

  private async requireMfa(req: Request, res: Response): Promise<void> {
    const user = req.user;

    if (!user) {
      throw new OAuthFailedException();
    }

    const challenge = await this.mfa.startChallenge(user.id);

    if (req.accepts(['json', 'html']) === 'json') {
      this.response.accepted(
        res,
        {
          mfaRequired: true,
          challengeToken: challenge.challengeToken,
          expiresAt: challenge.expiresAt,
        },
        { message: 'Two-factor authentication is required' },
      );
      return;
    }

    req.session.mfaChallenge = {
      token: challenge.challengeToken,
      expiresAt: challenge.expiresAt.toISOString(),
    };

    res.redirect(this.config.oauthMfaRedirect);
  }
}
