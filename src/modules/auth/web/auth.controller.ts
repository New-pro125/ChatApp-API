import type { Request, RequestHandler } from 'express';
import { inject, injectable } from 'inversify';
import type passport from 'passport';
import { CORE_TYPES } from '@/core/container/core.types.js';
import { InvalidCredentialsException } from '@/core/errors/domain.error.js';
import { UnauthorizedException } from '@/core/errors/http.error.js';
import type { ApiResponse } from '@/core/http/response/api-response.js';
import { AUTH_TYPES } from '@/modules/auth/auth.types.js';
import type { AuthService } from '@/modules/auth/logic/auth.service.js';
import type { AuthenticatedUser } from '@/modules/auth/logic/entities/authenticated-user.js';
import type { DeviceContext } from '@/modules/auth/logic/entities/refresh-token-record.js';
import type { TokenService } from '@/modules/auth/logic/token.service.js';
import { loginSchema, registerSchema } from '@/modules/auth/web/dto/auth.schemas.js';

type PassportStatic = typeof passport;

interface MfaChallengeInfo {
  mfaRequired?: unknown;
  challengeToken?: unknown;
  expiresAt?: unknown;
}

@injectable()
export class AuthController {
  constructor(
    @inject(AUTH_TYPES.AuthService) private readonly auth: AuthService,
    @inject(AUTH_TYPES.TokenService) private readonly tokens: TokenService,
    @inject(CORE_TYPES.Passport) private readonly passport: PassportStatic,
    @inject(CORE_TYPES.ApiResponse) private readonly response: ApiResponse,
  ) {}

  register: RequestHandler = async (req, res) => {
    const input = registerSchema.parse(req.body);
    const user = await this.auth.register(input);
    const tokens = await this.tokens.issue(user, this.deviceContext(req, input));

    this.response.created(res, { user, tokens });
  };

  login: RequestHandler = (req, res, next) => {
    const input = loginSchema.parse(req.body);
    req.body = input;

    this.passport.authenticate(
      'local',
      { session: false },
      async (error: unknown, user: Express.User | false | null | undefined, info: unknown) => {
        if (error) {
          next(error);
          return;
        }

        const challenge = this.readMfaChallenge(info);

        if (challenge) {
          this.response.accepted(
            res,
            { mfaRequired: true, ...challenge },
            { message: 'Two-factor authentication is required' },
          );
          return;
        }

        if (!user) {
          next(new InvalidCredentialsException());
          return;
        }

        try {
          const tokens = await this.tokens.issue(user, this.deviceContext(req, input));

          this.response.ok(res, { user, tokens });
        } catch (tokenError) {
          next(tokenError);
        }
      },
    )(req, res, next);
  };

  me: RequestHandler = (req, res) => {
    this.response.ok(res, this.requireUser(req));
  };

  private readMfaChallenge(info: unknown): { challengeToken: string; expiresAt: Date } | null {
    if (typeof info !== 'object' || info === null) {
      return null;
    }

    const record = info as MfaChallengeInfo;

    if (
      record.mfaRequired !== true ||
      typeof record.challengeToken !== 'string' ||
      typeof record.expiresAt !== 'string'
    ) {
      return null;
    }

    const expiresAt = new Date(record.expiresAt);

    if (Number.isNaN(expiresAt.getTime())) {
      return null;
    }

    return { challengeToken: record.challengeToken, expiresAt };
  }

  private deviceContext(
    req: Request,
    input: { deviceName?: string | undefined; deviceType?: string | undefined },
  ): DeviceContext {
    return {
      deviceName: input.deviceName,
      deviceType: input.deviceType,
      clientIp: req.ip ?? null,
      userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
    };
  }

  private requireUser(req: Request): AuthenticatedUser {
    if (!req.isAuthenticated()) {
      throw new UnauthorizedException();
    }

    return req.user;
  }
}
