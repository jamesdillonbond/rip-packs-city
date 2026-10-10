// Recipient guards shared by the retention crons (weekly-digest, signup-reminder).
//
// ⛔ BOTH GUARDS FAIL CLOSED (2026-10-10). Until then each cron carried its own
// copy of these two helpers and both copies failed OPEN:
//
//   - ensureUnsubToken read the subscriber row WITHOUT binding its error. A failed
//     read looked like "no row", so the unsubscribed_at check was skipped, the
//     insert then failed on the existing row, the re-read (also unbound) returned
//     nothing, and the helper handed back a random token that matched no row. The
//     cron then MAILED A PERSON WHO HAD UNSUBSCRIBED, with an unsubscribe link that
//     did nothing. The token-backfill `.update()` was discarded the same way, so a
//     row without a token got a link to a token that was never stored.
//   - alreadySent read the dedup row without binding its error, so a failed read
//     answered "not sent yet" and the recipient got the same email twice.
//
// A skipped send is retried by the next run; a wrong send cannot be taken back.
// So every read or write these guards cannot confirm answers "do not send", and
// says why, so the run log can count failures apart from opt-outs.

import { supabaseAdmin } from "@/lib/supabase"
import { randomUUID } from "crypto"

export type UnsubTokenResult =
  | { token: string }
  | { skip: true; reason: "unsubscribed" }
  | { skip: true; reason: "error"; error: string }

type SubscriberRow = {
  verification_token: string | null
  unsubscribed_at: string | null
  digest_weekly?: boolean | null
}

/**
 * Ensure an email_subscribers row exists so the unsubscribe link works, WITHOUT
 * clobbering a real subscriber's prefs. Returns the stored unsubscribe token, a
 * `reason: "unsubscribed"` skip for an opt-out, or a `reason: "error"` skip when
 * the opt-out state or the token could not be confirmed.
 *
 * `respectDigestOff`: the weekly digest also honours `digest_weekly = false`.
 */
export async function ensureUnsubToken(
  email: string,
  opts: { respectDigestOff?: boolean } = {},
): Promise<UnsubTokenResult> {
  const sb = supabaseAdmin as any
  const cols = opts.respectDigestOff
    ? "verification_token, unsubscribed_at, digest_weekly"
    : "verification_token, unsubscribed_at"
  const optedOut = (r: SubscriberRow) =>
    !!r.unsubscribed_at || (opts.respectDigestOff === true && r.digest_weekly === false)

  const { data: existing, error: readErr } = await sb
    .from("email_subscribers")
    .select(cols)
    .eq("email", email)
    .maybeSingle()
  if (readErr) return { skip: true, reason: "error", error: `subscriber_read: ${readErr.message}` }

  if (existing) {
    const row = existing as SubscriberRow
    if (optedOut(row)) return { skip: true, reason: "unsubscribed" }
    if (row.verification_token) return { token: row.verification_token }
    const token = randomUUID()
    // Conditional on the token still being NULL, and read back: a concurrent
    // writer's token wins and is the one we link to.
    const { data: updated, error: updErr } = await sb
      .from("email_subscribers")
      .update({ verification_token: token, updated_at: new Date().toISOString() })
      .eq("email", email)
      .is("verification_token", null)
      .select("verification_token")
    if (updErr) return { skip: true, reason: "error", error: `token_update: ${updErr.message}` }
    if (Array.isArray(updated) && updated.length > 0) return { token }
    return reread(sb, email, cols, optedOut)
  }

  const token = randomUUID()
  const insertRow: Record<string, unknown> = {
    email,
    verified: false, // re-engaged users, NOT opted-in subscribers
    verification_token: token,
    unsubscribed_at: null,
  }
  if (opts.respectDigestOff) insertRow.digest_weekly = true
  const { error: insErr } = await sb.from("email_subscribers").insert(insertRow)
  if (!insErr) return { token }
  // Lost an insert race (or the insert failed): only a row we can READ decides.
  return reread(sb, email, cols, optedOut)
}

async function reread(
  sb: any,
  email: string,
  cols: string,
  optedOut: (r: SubscriberRow) => boolean,
): Promise<UnsubTokenResult> {
  const { data, error } = await sb.from("email_subscribers").select(cols).eq("email", email).maybeSingle()
  if (error) return { skip: true, reason: "error", error: `subscriber_reread: ${error.message}` }
  const row = data as SubscriberRow | null
  if (!row) return { skip: true, reason: "error", error: "subscriber_row_missing" }
  if (optedOut(row)) return { skip: true, reason: "unsubscribed" }
  if (!row.verification_token) return { skip: true, reason: "error", error: "token_not_stored" }
  return { token: row.verification_token }
}

/**
 * Whether a `sent` alert_deliveries row exists for this recipient + bucket.
 * Returns `null` when the read failed: the caller must NOT send.
 */
export async function alreadySentEmail(args: {
  ownerKey: string
  alertKind: string
  subjectKey: string
  bucket: string
}): Promise<boolean | null> {
  const { data, error } = await (supabaseAdmin as any)
    .from("alert_deliveries")
    .select("id")
    .eq("owner_key", args.ownerKey)
    .eq("channel", "email")
    .eq("alert_kind", args.alertKind)
    .eq("subject_key", args.subjectKey)
    .eq("dedup_bucket", args.bucket)
    .eq("status", "sent")
    .maybeSingle()
  // maybeSingle errors on MORE than one row too: that is "sent", but an error
  // is not proof of it, so it refuses the send all the same.
  if (error) return null
  return !!data
}
