import {
  createPrivateKey,
  createPublicKey,
  type KeyObject,
  randomBytes,
  randomUUID,
} from 'node:crypto';
import { inject, injectable } from 'inversify';
import { jwtVerify, SignJWT } from 'jose';
import type { Logger } from 'pino';
import type { AppConfig } from '@/core/config/app.config.js';
import { CORE_TYPES } from '@/core/container/core.types.js';
import { InvalidAccessTokenException } from '@/core/errors/domain.error.js';

/** Claims carried by every access token. */
export interface AccessTokenClaims {
  userId: string;
  sessionVersion: number;
  jti: string;
  refreshTokenId: string;
  expiresAt: Date;
}

/** Typed view of the raw JWT payload used while narrowing claims. */
interface AccessTokenPayload {
  sub?: unknown;
  jti?: unknown;
  sv?: unknown;
  rti?: unknown;
  exp?: unknown;
}

/**
 * Signs and verifies the short-lived access tokens used for API requests.
 *
 * Tokens are EdDSA (Ed25519) JWTs that carry only the user id, session
 * version, and the id of the refresh token they were issued with; the user
 * record itself is resolved per request through the `PrincipalStore`.
 */
@injectable()
export class AccessTokenService {
  private readonly privateKey: KeyObject;
  private readonly publicKey: KeyObject;
  private readonly issuer: string;
  private readonly audience: string;
  private readonly ttlSeconds: number;

  constructor(
    @inject(CORE_TYPES.Config) config: AppConfig,
    @inject(CORE_TYPES.Logger) private readonly logger: Logger,
  ) {
    const seed = config.tokens.privateKeySeed ?? randomBytes(32);

    if (config.tokens.privateKeySeed === null) {
      this.logger.warn(
        'ACCESS_TOKEN_PRIVATE_KEY is not set; using an ephemeral signing key that invalidates tokens on restart',
      );
    }

    // A raw Ed25519 seed wrapped in the fixed PKCS#8 DER prefix for Ed25519.
    const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);

    this.privateKey = createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
    this.publicKey = createPublicKey(this.privateKey);
    this.issuer = config.tokens.issuer;
    this.audience = config.tokens.audience;
    this.ttlSeconds = config.tokens.accessTokenTtlSeconds;
  }

  async sign(
    userId: string,
    sessionVersion: number,
    refreshTokenId: string,
    issuedAt: Date,
  ): Promise<{ token: string; expiresAt: Date }> {
    const expiresAt = new Date(issuedAt.getTime() + this.ttlSeconds * 1000);

    const token = await new SignJWT({
      sv: sessionVersion,
      rti: refreshTokenId,
    })
      .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT' })
      .setSubject(userId)
      .setJti(randomUUID())
      .setIssuer(this.issuer)
      .setAudience(this.audience)
      .setIssuedAt(Math.floor(issuedAt.getTime() / 1000))
      .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
      .sign(this.privateKey);

    return { token, expiresAt };
  }

  async verify(raw: string): Promise<AccessTokenClaims> {
    try {
      const payload: AccessTokenPayload = await jwtVerify(raw, this.publicKey, {
        algorithms: ['EdDSA'],
        issuer: this.issuer,
        audience: this.audience,
        clockTolerance: 5,
      }).then(({ payload: decoded }) => decoded);

      const userId = typeof payload.sub === 'string' ? payload.sub : null;
      const sessionVersion = typeof payload.sv === 'number' ? payload.sv : null;
      const jti = typeof payload.jti === 'string' ? payload.jti : null;
      const refreshTokenId = typeof payload.rti === 'string' ? payload.rti : null;
      const expiresAtMs = typeof payload.exp === 'number' ? payload.exp * 1000 : null;

      if (!(userId && sessionVersion && jti && refreshTokenId && expiresAtMs)) {
        throw new Error('Token payload is missing required claims');
      }

      return { userId, sessionVersion, jti, refreshTokenId, expiresAt: new Date(expiresAtMs) };
    } catch (error) {
      throw new InvalidAccessTokenException('Access token is invalid or expired', { cause: error });
    }
  }

  get accessTokenTtlSeconds(): number {
    return this.ttlSeconds;
  }
}
