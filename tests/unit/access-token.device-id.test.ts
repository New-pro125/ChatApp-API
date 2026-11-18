import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { decodeJwt, SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { AccessTokenService } from '@/core/auth/access-token.service.js';
import { InvalidAccessTokenException } from '@/core/errors/domain.error.js';

function makeService(privateKey: KeyObject): AccessTokenService {
  const raw = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32);

  return new AccessTokenService(
    {
      tokens: {
        privateKeySeed: raw,
        issuer: 'test-issuer',
        audience: 'test-audience',
        accessTokenTtlSeconds: 300,
      },
    } as never,
    { warn: () => undefined } as never,
  );
}

describe('AccessTokenService device id', () => {
  it('signs and verifies the refresh family id as did', async () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const service = makeService(privateKey);

    const { token } = await service.sign('user-1', 1, 'refresh-1', 'device-1', new Date());
    const claims = await service.verify(token);

    expect(decodeJwt(token)).toMatchObject({ did: 'device-1' });
    expect(claims.deviceId).toBe('device-1');
  });

  it('rejects a token without a did claim', async () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const service = makeService(privateKey);
    const nowSeconds = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ sv: 1, rti: 'refresh-1' })
      .setProtectedHeader({ alg: 'EdDSA', typ: 'JWT' })
      .setSubject('user-1')
      .setJti('jti-1')
      .setIssuer('test-issuer')
      .setAudience('test-audience')
      .setIssuedAt(nowSeconds)
      .setExpirationTime(nowSeconds + 300)
      .sign(privateKey);

    await expect(service.verify(token)).rejects.toBeInstanceOf(InvalidAccessTokenException);
  });
});
