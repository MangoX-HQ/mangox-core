/**
 * Shared JWT verification — supports 2 algorithms:
 *   - RS256: token from the central SSO (Studio), verified with the PUBLIC KEY.
 *   - HS256: internal/dev token, verified with JWT_SECRET.
 * Auto-detects the algorithm from the JWT header. Normalizes the payload (sub → id).
 *
 * The public key is read once at import time from SSO_PUBLIC_KEY_PATH (default: .sso-keys
 * at the repo root). If it cannot be read → only HS256 works (RS256 will throw).
 */

import jwt from 'jsonwebtoken';
import * as fs from 'fs';
import * as path from 'path';
import { getTenantSlug } from './tenant';

const HS_SECRET = process.env.JWT_SECRET || '';

const SSO_PUBLIC_KEY: string | null = (() => {
  // Prefers an inline key via env (convenient for Docker — no need to mount a file). `\n` is un-escaped.
  const inline = process.env.SSO_PUBLIC_KEY;
  if (inline && inline.includes('BEGIN')) {
    console.log('[jwt-verify] SSO public key loaded from env SSO_PUBLIC_KEY');
    return inline.replace(/\\n/g, '\n');
  }
  try {
    const p = process.env.SSO_PUBLIC_KEY_PATH
      || path.resolve(process.cwd(), '../.sso-keys/public.pem');
    const key = fs.readFileSync(p, 'utf8');
    console.log(`[jwt-verify] SSO public key loaded from ${p}`);
    return key;
  } catch {
    console.warn('[jwt-verify] SSO public key not found — chỉ HS256 hoạt động (set SSO_PUBLIC_KEY / SSO_PUBLIC_KEY_PATH cho RS256)');
    return null;
  }
})();

export interface VerifiedUser {
  id: string;
  email?: string;
  username?: string;
  phone?: string;
  role_system?: string;
  role_name?: string;
  tenant_id?: string;
  is_super_admin?: boolean;
  [k: string]: any;
}

/**
 * Verifies the token according to the alg in the header. Throws if the signature is
 * invalid / expired / alg unsupported / RS256 with a missing public key.
 */
export function verifyToken(token: string): VerifiedUser {
  const decoded = jwt.decode(token, { complete: true }) as any;
  const alg = decoded?.header?.alg;

  let payload: any;
  if (alg === 'RS256') {
    if (!SSO_PUBLIC_KEY) throw new Error('SSO public key chưa cấu hình (SSO_PUBLIC_KEY_PATH)');
    payload = jwt.verify(token, SSO_PUBLIC_KEY, { algorithms: ['RS256'] });
  } else if (alg === 'HS256') {
    payload = jwt.verify(token, HS_SECRET, { algorithms: ['HS256'] });
  } else {
    throw new Error(`Unsupported JWT alg: ${alg}`);
  }

  // SSO uses `sub`, internal tokens use `id` → normalize to `id`.
  return { ...payload, id: payload.id || payload.sub };
}

/**
 * Single-tenant isolation: a token carrying a given tenant_id is only accepted by
 * that tenant's deploy. Compared against env TENANT. Tokens that don't declare a
 * tenant_id (e.g. internal admin) → not enforced.
 */
export function tenantMatches(user: VerifiedUser): boolean {
  if (!user.tenant_id) return true;
  return user.tenant_id === getTenantSlug();
}
