import type { Request, RequestHandler, Response } from 'express';
import { inject, injectable } from 'inversify';
import type { AppConfig } from '@/core/config/app.config.js';
import { CORE_TYPES } from '@/core/container/core.types.js';
import { OAuthFailedException } from '@/core/errors/domain.error.js';
import type { ApiResponse } from '@/core/http/response/api-response.js';
import { AUTH_TYPES } from '@/modules/auth/auth.types.js';
import type { DeviceContext } from '@/modules/auth/logic/entities/refresh-token-record.js';
import type { MfaService } from '@/modules/auth/logic/mfa.service.js';
import type { TokenService } from '@/modules/auth/logic/token.service.js';

@injectable()
export class OAuthController {
  constructor(
    @inject(AUTH_TYPES.TokenService) private readonly tokens: TokenService,
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

      if (req.accepts(['json', 'html']) === 'json') {
        const tokens = await this.tokens.issue(req.user, this.deviceContext(req));

        this.response.ok(res, { user: req.user, tokens });
        return;
      }

      const grant = await this.tokens.issueGrant(req.user.id);

      res.redirect(this.withQuery(this.config.oauthSuccessRedirect, { code: grant }));
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

    // The challenge token is single-use, hashed server-side, and short-lived;
    // the web client posts it straight back to the MFA verify endpoint.
    res.redirect(
      this.withQuery(this.config.oauthMfaRedirect, {
        challenge: challenge.challengeToken,
        expiresAt: challenge.expiresAt.toISOString(),
      }),
    );
  }

  private deviceContext(req: Request): DeviceContext {
    return {
      clientIp: req.ip ?? null,
      userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
    };
  }

  private withQuery(target: string, params: Record<string, string>): string {
    const url = new URL(target);

    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }

    return url.toString();
  }
}
