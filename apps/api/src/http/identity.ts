import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { Config } from '../config.js';

/**
 * PRD 12: auth lives in IAP. There is no user table, no passwords, and no sessions —
 * the app reads the identity IAP asserts and that is the whole of it.
 *
 * One deviation from "write zero auth code": the plain `x-goog-authenticated-user-*`
 * headers are only trustworthy if nothing can reach this service except through IAP.
 * That is an ingress setting, and an ingress setting is one console click away from
 * turning the app into an open door that still looks authenticated. Verifying the
 * signed assertion costs ~40 lines and removes that failure mode entirely.
 * See docs/prd-deltas.md.
 */

export interface Identity {
  /** Stable subject IAP asserts, e.g. `accounts.google.com:1234567890`. */
  subject: string;
  email: string;
}

const IAP_ISSUER = 'https://cloud.google.com/iap';
const IAP_JWKS_URL = new URL('https://www.gstatic.com/iap/verify/public_key-jwk');

const HEADER_ASSERTION = 'x-goog-iap-jwt-assertion';
const HEADER_EMAIL = 'x-goog-authenticated-user-email';
const HEADER_SUBJECT = 'x-goog-authenticated-user-id';

export class UnauthenticatedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnauthenticatedError';
  }
}

/** IAP prefixes both header values with the identity provider. */
function stripProvider(value: string): string {
  const separator = value.indexOf(':');
  return separator === -1 ? value : value.slice(separator + 1);
}

export type HeaderBag = Record<string, string | string[] | undefined>;

function header(headers: HeaderBag, name: string): string | undefined {
  const raw = headers[name];
  return Array.isArray(raw) ? raw[0] : raw;
}

export interface IdentityReader {
  read(headers: HeaderBag): Promise<Identity>;
}

export function createIdentityReader(config: Config): IdentityReader {
  // PRD 2 requires one command to run locally, and there is no IAP in front of a
  // laptop. The shim produces the same Identity shape so there is exactly one code
  // path downstream. config.ts refuses to boot if this is set in production.
  if (config.devIdentity) {
    const email = config.devIdentity;
    const identity: Identity = { subject: `dev:${email}`, email };
    return { read: async () => identity };
  }

  const jwks = config.verifyIapJwt ? createRemoteJWKSet(IAP_JWKS_URL) : undefined;

  return {
    async read(headers: HeaderBag): Promise<Identity> {
      if (jwks) {
        const assertion = header(headers, HEADER_ASSERTION);
        if (!assertion) {
          throw new UnauthenticatedError('missing IAP assertion');
        }
        const { payload } = await jwtVerify(assertion, jwks, {
          issuer: IAP_ISSUER,
          audience: config.iapAudience!,
        }).catch((cause: unknown) => {
          throw new UnauthenticatedError(`invalid IAP assertion: ${(cause as Error).message}`);
        });

        const email = typeof payload['email'] === 'string' ? payload['email'] : undefined;
        if (!payload.sub || !email) {
          throw new UnauthenticatedError('IAP assertion carried no subject or email');
        }
        return { subject: payload.sub, email };
      }

      // Unverified path: only reachable when ingress is restricted to IAP, which
      // config.ts warns about at boot.
      const subject = header(headers, HEADER_SUBJECT);
      const email = header(headers, HEADER_EMAIL);
      if (!subject || !email) {
        throw new UnauthenticatedError('missing IAP identity headers');
      }
      return { subject: stripProvider(subject), email: stripProvider(email) };
    },
  };
}
