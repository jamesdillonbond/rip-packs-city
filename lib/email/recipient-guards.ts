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

/**
 * Claim this recipient + bucket BEFORE sending (2026-11-02). Reading "already
 * sent?" and writing the record AFTER the send leaves a window: two overlapping
 * runs both pass the read, and a record write that fails lets every later run
 * pass it again. The claim closes it by ORDER: an insert-only write on
 * alert_deliveries' UNIQUE (owner_key, channel, alert_kind, subject_key,
 * dedup_bucket) with status 'sending' — which the generic sender never touches,
 * since claim_pending_deliveries takes only 'pending'.
 *
 *  - `claimed`: this run holds the row; call `markSent()` after a successful
 *    send and `release()` after a failed one (so a later run may retry).
 *  - `held`: another run (or an earlier send) owns it — do NOT send.
 *  - `error`: the claim could not be written — do NOT send (fails closed).
 *
 * A crash between claim and send leaves the row 'sending': that recipient is
 * skipped for the bucket rather than mailed twice.
 */
export type EmailClaim =
  | { state: "claimed"; markSent: () => Promise<void>; release: () => Promise<void> }
  | { state: "held" }
  | { state: "error"; error: string }

export async function claimEmailDelivery(args: {
  ownerKey: string
  alertKind: string
  subjectKey: string
  bucket: string
  /** Defaults to ownerKey (email-keyed senders); weekly-digest keys owner by user id. */
  channelUserId?: string
  payload?: Record<string, unknown>
  log?: (msg: string) => void
}): Promise<EmailClaim> {
  const sb = supabaseAdmin as any
  const { data, error } = await sb
    .from("alert_deliveries")
    .upsert(
      {
        owner_key: args.ownerKey,
        channel: "email",
        channel_user_id: args.channelUserId ?? args.ownerKey,
        alert_kind: args.alertKind,
        subject_key: args.subjectKey,
        dedup_bucket: args.bucket,
        payload: args.payload ?? {},
        status: "sending",
      },
      { onConflict: "owner_key,channel,alert_kind,subject_key,dedup_bucket", ignoreDuplicates: true },
    )
    .select("id")
  if (error) return { state: "error", error: `claim: ${error.message}` }
  const id = Array.isArray(data) && data[0]?.id != null ? String(data[0].id) : null
  if (!id) return { state: "held" }
  const log = args.log ?? ((m: string) => console.log(m))
  const tail = args.ownerKey.slice(-8)
  return {
    state: "claimed",
    // A failed mark leaves the row 'sending', which still blocks a resend.
    markSent: async () => {
      const { error: e } = await sb.from("alert_deliveries").update({ status: "sent", sent_at: new Date().toISOString() }).eq("id", id)
      if (e) log(`claim mark-sent err ${tail}: ${e.message}`)
    },
    release: async () => {
      const { error: e } = await sb.from("alert_deliveries").delete().eq("id", id)
      if (e) log(`claim release err ${tail}: ${e.message}`)
    },
  }
}
