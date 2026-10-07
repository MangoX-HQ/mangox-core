import crypto from 'crypto';
import { redisClient } from '../../configs/redis';

/**
 * Token blacklist / revoke — 2-tier Redis (see docs/auth-token-blacklist-otp-design.md).
 *
 * Since the access token is a stateless JWT (RS256, expiresIn 7d, NOT stored anywhere, NO `jti`),
 * old tokens stay alive until they expire after logout / password change / ban. The 2 tiers below
 * revoke tokens WITHOUT changing the payload → applies even to already-issued tokens:
 *
 *   Tier 1  bl:tok:<sha256(rawJwt)>  = "1"          TTL = exp - now   → revoke 1 token (logout)
 *   Tier 2  bl:user:<userId>         = revokedAt(s)  TTL = 7d          → revoke-all: guard rejects
 *                                                                        every token with iat < revokedAt
 *
 * EVERY function swallows Redis errors (fail-open) + logs: Redis going down must NOT break auth. Trade-off:
 * while Redis is down, revocation is temporarily ineffective (acceptable — see doc §4).
 *
 * Note: the real key also has redisKeyPrefix prepended automatically by redisClient.
 */

// TTL of key bl:user:* — equals the max access-token lifetime (7d). Tokens older than 7d already self-expire so the key
// is meaningless by then; this TTL is only to keep Redis from bloating.
const REVOKE_TTL_SECONDS = Number(process.env.TOKEN_REVOKE_TTL) || 604800;

export function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Get `exp` (seconds) from the JWT WITHOUT re-verifying (the guard already verified it). Manually
 * parses the base64url payload — no extra dependency needed. Returns 0 if the token is malformed / has no exp.
 */
export function decodeExp(rawJwt: string): number {
  try {
    const payloadPart = rawJwt.split('.')[1];
    if (!payloadPart) return 0;
    const json = Buffer.from(payloadPart, 'base64url').toString('utf8');
    const exp = JSON.parse(json)?.exp;
    return typeof exp === 'number' ? exp : 0;
  } catch {
    return 0;
  }
}

/** Remaining TTL of the token (seconds), >= 0. */
function remainingTtl(expSeconds: number): number {
  return Math.max(0, expSeconds - nowSec());
}

/**
 * Tier 1 — blacklist the exact token string being held (current device logout).
 * The token is hashed so the raw token isn't stored in Redis. TTL = remaining lifetime → self-expires.
 */
export async function blacklistToken(rawJwt: string): Promise<void> {
  try {
    const ttl = remainingTtl(decodeExp(rawJwt));
    if (ttl <= 0) return; // token already expired → no need to blacklist
    await redisClient.set(`bl:tok:${sha256(rawJwt)}`, '1', 'EX', ttl);
  } catch (err) {
    console.warn('[token-blacklist] blacklistToken lỗi (fail-open):', (err as Error)?.message);
  }
}

/** Tier 1 — has this token been revoked? */
export async function isTokenBlacklisted(rawJwt: string): Promise<boolean> {
  try {
    const exists = await redisClient.exists(`bl:tok:${sha256(rawJwt)}`);
    return exists === 1;
  } catch (err) {
    console.warn('[token-blacklist] isTokenBlacklisted lỗi (fail-open):', (err as Error)?.message);
    return false; // fail-open
  }
}

/**
 * Tier 2 — revoke ALL tokens of a user (password change/reset, admin ban).
 * 1 key/user, O(1): every token with iat < revokedAt gets guard-rejected. Tokens minted AFTER
 * this point (re-login / re-issue) have iat >= revokedAt → still valid.
 *
 * ⚠️ Call revokeAllForUser BEFORE minting a new token so the new token's iat >= revokedAt is guaranteed.
 */
export async function revokeAllForUser(userId: string, atSec: number = nowSec()): Promise<void> {
  try {
    await redisClient.set(`bl:user:${userId}`, String(atSec), 'EX', REVOKE_TTL_SECONDS);
  } catch (err) {
    console.warn('[token-blacklist] revokeAllForUser lỗi (fail-open):', (err as Error)?.message);
  }
}

/** Tier 2 — has this token (by iat) been revoke-all'd? Uses strict `<` so a token minted in the same second is still valid. */
export async function isUserRevoked(userId: string, iat?: number): Promise<boolean> {
  if (!userId || iat == null) return false;
  try {
    const revokedAt = await redisClient.get(`bl:user:${userId}`);
    return revokedAt != null && Number(iat) < Number(revokedAt);
  } catch (err) {
    console.warn('[token-blacklist] isUserRevoked lỗi (fail-open):', (err as Error)?.message);
    return false; // fail-open
  }
}
