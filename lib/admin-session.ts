// lib/admin-session.ts
//
// Short-lived, signed admin sessions (security audit 2026-10-25, R134 step 2).
//
// WHY: the admin pages used to keep the MASTER `RPC_ADMIN_TOKEN` in
// localStorage (and one page in a JS-readable 30-day cookie). With
// `script-src 'unsafe-inline'` any XSS on the origin could read it and own every
// admin route forever, until a manual rotation. Now the browser exchanges the
// master token ONCE (POST /api/admin/session) for a session that:
//   * expires on its own (ADMIN_SESSION_TTL_MS),
//   * cannot mint another session (that route accepts the master token only),
//   * dies with the master token: its HMAC key IS the master token, so rotating
//     RPC_ADMIN_TOKEN invalidates every outstanding session at once.
// Scripts, cron-job.org and curl keep sending the master token as before.
//
// Format: `rpcadm1.<expiresAtMs>.<base64url HMAC-SHA256(key=master, "rpc-admin-session:v1:<exp>")>`
//
// Pure JS (@noble/hashes) on purpose: lib/auth/bearer-secret.ts, which calls
// this, is imported by routes that may run on the Edge runtime (no node:crypto).

import { hmac } from "@noble/hashes/hmac"
import { sha256 } from "@noble/hashes/sha256"

export const ADMIN_SESSION_PREFIX = "rpcadm1."
export const ADMIN_SESSION_TTL_MS = 12 * 60 * 60 * 1000

function b64url(bytes: Uint8Array): string {
  let bin = ""
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function sign(master: string, exp: number): string {
  return b64url(hmac(sha256, master, `rpc-admin-session:v1:${exp}`))
}

function equal(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length)
  let diff = a.length ^ b.length
  for (let i = 0; i < len; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0)
  return diff === 0
}

/** Mint a session for `master`, or null when there is no master to sign with. */
export function mintAdminSession(
  master: string | undefined,
  now = Date.now(),
): { session: string; expiresAt: number } | null {
  if (typeof master !== "string" || master.length === 0) return null
  const exp = now + ADMIN_SESSION_TTL_MS
  return { session: `${ADMIN_SESSION_PREFIX}${exp}.${sign(master, exp)}`, expiresAt: exp }
}

/**
 * True only for an unexpired session signed with `master`. Fails closed on an
 * unset master, a malformed value, an expiry in the past, or an expiry further
 * out than one TTL (a session we never minted).
 */
export function verifyAdminSession(presented: string | null | undefined, master: string | undefined, now = Date.now()): boolean {
  if (typeof master !== "string" || master.length === 0) return false
  if (typeof presented !== "string" || !presented.startsWith(ADMIN_SESSION_PREFIX)) return false
  const rest = presented.slice(ADMIN_SESSION_PREFIX.length)
  const dot = rest.indexOf(".")
  if (dot <= 0) return false
  const expStr = rest.slice(0, dot)
  if (!/^\d{13}$/.test(expStr)) return false
  const exp = Number(expStr)
  if (!(exp > now) || exp > now + ADMIN_SESSION_TTL_MS + 60_000) return false
  return equal(rest.slice(dot + 1), sign(master, exp))
}
