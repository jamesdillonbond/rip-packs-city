// lib/alerts/email-pause.ts — the one-tap "pause alert emails" link (2026-10-24).
//
// Alert emails ended with "Manage your alerts" → /alerts, which needs a sign-in:
// no one-click opt-out, no List-Unsubscribe header (Gmail / Yahoo require both
// from bulk senders since 2024). Each alert email now carries a signed link that
// works WITHOUT a session. The token is an HMAC of the recipient address with a
// domain-separation label, so it cannot be forged for another address and cannot
// be replayed against a different RPC signing purpose.
//
// What "pause" does: the recipient's verified `email` row in
// public.notification_channels is set verified = false. The enqueue functions
// read only verified channels, so no further alert email is queued; turning the
// channel back on is the existing /alerts channel flow. Telegram / Discord are
// untouched — the reader paused EMAIL.

import { createHmac, timingSafeEqual } from "node:crypto"
import { signingSecret } from "@/lib/auth/flow-signature"

const LABEL = "rpc-alert-email-pause:v1"
export const ALERT_EMAIL_PAUSE_PATH = "/api/subscribe/alerts-pause"

function normEmail(email: string): string {
  return email.trim().toLowerCase()
}

export function alertEmailPauseToken(email: string, secret: string = signingSecret()): string {
  return createHmac("sha256", secret).update(`${LABEL}:${normEmail(email)}`, "utf8").digest("base64url")
}

export function verifyAlertEmailPauseToken(email: string, token: string, secret: string = signingSecret()): boolean {
  if (!email || !token) return false
  const want = Buffer.from(alertEmailPauseToken(email, secret))
  const got = Buffer.from(token)
  return want.length === got.length && timingSafeEqual(want, got)
}

/** Absolute pause URL for one recipient (the List-Unsubscribe target and the footer link). */
export function alertEmailPauseUrl(site: string, email: string, secret?: string): string {
  const e = Buffer.from(normEmail(email), "utf8").toString("base64url")
  return `${site}${ALERT_EMAIL_PAUSE_PATH}?e=${e}&t=${alertEmailPauseToken(email, secret)}`
}

/** Decodes the `e` parameter; null when it is not a plausible address. */
export function decodeEmailParam(e: string | null): string | null {
  if (!e || e.length > 400) return null
  try {
    const s = Buffer.from(e, "base64url").toString("utf8")
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? normEmail(s) : null
  } catch {
    return null
  }
}
