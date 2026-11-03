import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';

export interface AccessConfig {
  teamDomain: string;
  audience: string;
  adminEmail: string;
}

export interface AdminIdentity { sub: string }

/** Verify the Access signature as well as the issuer, audience and person. */
export function createAccessVerifier(config: AccessConfig, resolver?: JWTVerifyGetKey) {
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.cloudflareaccess\.com$/.test(config.teamDomain)
    || !config.audience?.trim() || !/^[^\s@]+@[^\s@]+$/.test(config.adminEmail)) {
    throw new Error('Invalid Access configuration');
  }
  const issuer = `https://${config.teamDomain}`;
  const keys = resolver ?? createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`), {
    timeoutDuration: 5000, cacheMaxAge: 300_000, cooldownDuration: 30_000,
  });
  return async (request: Request): Promise<AdminIdentity> => {
    try {
      const token = request.headers.get('Cf-Access-Jwt-Assertion');
      if (!token || token.length > 16_384) throw new Error('Missing assertion');
      const { payload } = await jwtVerify(token, keys, {
        issuer, audience: config.audience, algorithms: ['RS256'],
        requiredClaims: ['sub', 'email', 'exp', 'iat'],
      });
      if (payload.type !== 'app' || typeof payload.sub !== 'string' || !payload.sub
        || typeof payload.email !== 'string'
        || payload.email.toLowerCase() !== config.adminEmail.toLowerCase()
        || typeof payload.iat !== 'number' || payload.iat > Date.now() / 1000 + 30) {
        throw new Error('Unauthorized identity');
      }
      return { sub: payload.sub };
    } catch {
      throw new Error('Unauthorized');
    }
  };
}
