// lib/auth/allow-cookie.ts
//
// The proxy's allow-list cache cookie (`rpc_al_check`), SIGNED (2026-10-27).
//
// WHY: the cookie was unsigned JSON { email, expiresAt }. The 10-25 audit capped expiresAt at one TTL ahead, but
// a user removed from the allow-list could still rewrite { email: <own>, expiresAt: now + 60 s } on every request
// and the proxy would never call check_email_allowed again. Now the value carries an HMAC over email + expiry, so
// only a cookie the proxy wrote can skip the RPC. A missing or bad signature reads as no cookie: one RPC, then a
// fresh signed cookie — so cookies written before this change cost one extra check, nothing else.
//
// Key: SUPABASE_SERVICE_ROLE_KEY — server-only, already required by the proxy's allow-list RPC, never sent to a
// browser. Rotating it invalidates every cached cookie (each costs one RPC). Domain-separated by the message prefix.
// Pure JS (@noble/hashes), like lib/admin-session.ts, so it runs on any runtime.

import { hmac } from "@noble/hashes/hmac"
import { sha256 } from "@noble/hashes/sha256"

export type AllowCacheEntry = { email: string; expiresAt: number }

function b64url(bytes: Uint8Array): string {
  let bin = ""
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function sign(key: string, email: string, expiresAt: number): string {
  return b64url(hmac(sha256, key, `rpc-allow-cookie:v1:${email}:${expiresAt}`))
}

function equal(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length)
  let diff = a.length ^ b.length
  for (let i = 0; i < len; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0)
  return diff === 0
}

/** The cookie value for `email` expiring at `expiresAt`, or null when there is no key to sign with. */
export function encodeAllowCookie(email: string, expiresAt: number, key: string | undefined): string | null {
  if (typeof key !== "string" || key.length === 0) return null
  return JSON.stringify({ email, expiresAt, sig: sign(key, email, expiresAt) })
}

/**
 * The entry, only when the value parses AND its signature verifies under `key`. Anything else — no key, malformed
 * JSON, missing fields, an unsigned (pre-2026-10-27) or tampered value — is null, i.e. "no cache, ask the RPC".
 */
export function decodeAllowCookie(raw: string | undefined, key: string | undefined): AllowCacheEntry | null {
  if (!raw || typeof key !== "string" || key.length === 0) return null
  try {
    const parsed = JSON.parse(raw) as { email?: unknown; expiresAt?: unknown; sig?: unknown }
    if (typeof parsed.email !== "string" || typeof parsed.expiresAt !== "number" || typeof parsed.sig !== "string") return null
    if (!equal(parsed.sig, sign(key, parsed.email, parsed.expiresAt))) return null
    return { email: parsed.email, expiresAt: parsed.expiresAt }
  } catch {
    return null
  }
}
