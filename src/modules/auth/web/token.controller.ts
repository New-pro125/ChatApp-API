import type { Request, RequestHandler } from 'express';
import { inject, injectable } from 'inversify';
import type { AccessTokenClaims } from '@/core/auth/access-token.service.js';
import { CORE_TYPES } from '@/core/container/core.types.js';
import { NotFoundException, UnauthorizedException } from '@/core/errors/http.error.js';
import type { ApiResponse } from '@/core/http/response/api-response.js';
import { AUTH_TYPES } from '@/modules/auth/auth.types.js';
import type { DeviceContext } from '@/modules/auth/logic/entities/refresh-token-record.js';
import type { TokenService } from '@/modules/auth/logic/token.service.js';
import {
  exchangeGrantSchema,
  logoutSchema,
  refreshSchema,
  revokeSessionParamsSchema,
} from '@/modules/auth/web/dto/auth.schemas.js';

/**
 * Token lifecycle endpoints: refresh, grant exchange, logout, and the
 * per-device session registry.
 */
@injectable()
export class TokenController {
  constructor(
    @inject(AUTH_TYPES.TokenService) private readonly tokens: TokenService,
    @inject(CORE_TYPES.ApiResponse) private readonly response: ApiResponse,
  ) {}

  refresh: RequestHandler = async (req, res) => {
    const input = refreshSchema.parse(req.body);
    const result = await this.tokens.refresh(input.refreshToken);

    this.response.ok(res, result);
  };

  exchangeGrant: RequestHandler = async (req, res) => {
    const input = exchangeGrantSchema.parse(req.body);
    const result = await this.tokens.exchangeGrant(input.code, this.deviceContext(req));

    this.response.ok(res, result);
  };

  logout: RequestHandler = async (req, res) => {
    const input = logoutSchema.parse(req.body ?? {});
    await this.tokens.logout(input.refreshToken, this.requireClaims(req));

    this.response.noContent(res);
  };

  logoutAll: RequestHandler = async (req, res) => {
    await this.tokens.logoutAll(this.requireClaims(req).userId);

    this.response.noContent(res);
  };

  sessions: RequestHandler = async (req, res) => {
    const claims = this.requireClaims(req);
    const items = await this.tokens.listSessions(claims.userId);
    const sessions = items.map((session) => ({
      ...session,
      current: session.id === claims.refreshTokenId,
    }));

    this.response.list(res, sessions);
  };

  revokeSession: RequestHandler = async (req, res) => {
    const id = revokeSessionParamsSchema.parse(req.params).id;
    const revoked = await this.tokens.revokeSession(this.requireClaims(req).userId, id);

    if (revoked === null) {
      throw new NotFoundException('Session not found');
    }

    this.response.noContent(res);
  };

  private deviceContext(req: Request): DeviceContext {
    return {
      clientIp: req.ip ?? null,
      userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
    };
  }

  private requireClaims(req: Request): AccessTokenClaims {
    if (!req.auth) {
      throw new UnauthorizedException();
    }

    return req.auth;
  }
}
