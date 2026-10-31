// lib/trade-room/notify.ts
//
// Counterparty notices for the trade room (2026-10-31). A trade is a two-person,
// asynchronous flow — the page polls while it is open, but the collector who is
// NOT on the page learns nothing. So four moments email the OTHER side, once each,
// fire-and-forget from the route (`after()`): the counterparty JOINED, the other
// side ACCEPTED (your turn / ready to sign), the room was CANCELLED, the trade
// SEALED. Transactional mail to a participant in an action they chose, from the
// same sender as the account welcome.
//
// Honesty / safety rules:
//   • A notice never carries a wallet address, a Moment list, a price, an FMV or
//     a confidence; it names the other collector by username and links the room.
//   • A failed send is logged and dropped — it never fails the action it follows,
//     and it is never retried into a duplicate.
//   • An opt-out in email_subscribers (unsubscribed_at) is honoured; a read that
//     cannot confirm the opt-out state SKIPS (fail closed, like the retention crons).
//   • The recipient's address is read from auth (service role) at send time and
//     never stored on the room.

import type { SupabaseClient } from "@supabase/supabase-js"
import { sendViaResend, WELCOME_FROM_ADDRESS, type SendEmailArgs, type SendResult } from "@/lib/welcome/send-account-welcome"
import { usernamesFor } from "@/lib/trade-room/view"
import type { LoadedRoom } from "@/lib/trade-room/store"

export type TradeNotice = "joined" | "accepted" | "ready" | "cancelled" | "sealed"

const SITE_URL = "https://www.rippackscity.com"
const ACCENT = "#e55a4c" // email red — mail clients have no CSS custom properties (hardcoded on purpose)
const BG = "#0a0a0a"
const PANEL = "#18181b"
const PANEL_BORDER = "#27272a"
const TEXT = "#fafafa"
const TEXT_MUTED = "rgba(255,255,255,0.65)"

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

export function tradeRoomUrl(code: string): string {
  return `${SITE_URL}/trades/${encodeURIComponent(code)}`
}

/** Subject + body for one notice. Pure; no I/O. */
export function buildTradeNoticeEmail(notice: TradeNotice, opts: { code: string; other: string }): { subject: string; html: string; text: string } {
  const other = opts.other.trim() || "A collector"
  const url = tradeRoomUrl(opts.code)
  let subject: string
  let headline: string
  let body: string
  let cta: string
  switch (notice) {
    case "joined":
      subject = `${other} joined your trade room`
      headline = `${other} is in.`
      body = `${other} joined your trade room. Both of you can now connect a Flow Wallet, pick Moments and accept the exact trade.`
      cta = "Open the trade room"
      break
    case "accepted":
      subject = `${other} accepted the trade — your turn`
      headline = "Your turn."
      body = `${other} accepted the trade as it stands. Review it; if you accept the same version, it is ready to sign. Any change to either side resets both acceptances.`
      cta = "Review the trade"
      break
    case "ready":
      subject = `Trade with ${other} is ready to sign`
      headline = "Both sides accepted."
      body = `You and ${other} accepted the same version. Simulate it on mainnet, then sign — one transaction, both wallets, so either every Moment moves or nothing does. RPC holds nothing and charges no fee.`
      cta = "Sign the trade"
      break
    case "cancelled":
      subject = `${other} cancelled the trade`
      headline = "Trade cancelled."
      body = `${other} cancelled the trade room. Nothing moved. You can start a new room any time.`
      cta = "See your trades"
      break
    case "sealed":
      subject = `Trade with ${other} sealed on chain`
      headline = "Sealed."
      body = `Your trade with ${other} sealed on the Flow blockchain. The room shows where each Moment landed, read from the chain.`
      cta = "See where everything landed"
      break
  }
  const link = notice === "cancelled" ? `${SITE_URL}/trades` : url
  const text = `${headline}\n\n${body}\n\n${cta}: ${link}\n\nRip Packs City — ${SITE_URL}`
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:${BG};color:${TEXT};font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BG};"><tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:${PANEL};border:1px solid ${PANEL_BORDER};border-radius:8px;">
<tr><td style="padding:28px 28px 8px;font-size:12px;letter-spacing:0.12em;text-transform:uppercase;color:${ACCENT};font-weight:700;">Rip Packs City · Trade room</td></tr>
<tr><td style="padding:0 28px 8px;font-size:24px;font-weight:800;color:${TEXT};">${esc(headline)}</td></tr>
<tr><td style="padding:0 28px 20px;font-size:15px;line-height:1.55;color:${TEXT_MUTED};">${esc(body)}</td></tr>
<tr><td style="padding:0 28px 28px;"><a href="${esc(link)}" style="display:inline-block;padding:12px 18px;background:${ACCENT};color:#ffffff;text-decoration:none;font-weight:700;border-radius:6px;font-size:14px;">${esc(cta)} →</a></td></tr>
<tr><td style="padding:0 28px 24px;font-size:12px;line-height:1.5;color:${TEXT_MUTED};">You get this because you are one of the two collectors in this trade room. ${esc(SITE_URL)}</td></tr>
</table></td></tr></table></body></html>`
  return { subject, html, text }
}

export interface NotifyDeps {
  send?: (args: SendEmailArgs) => Promise<SendResult>
  /** Resolves a user id to its account email; default reads auth via the service role. */
  lookupEmail?: (db: SupabaseClient, userId: string) => Promise<string | null>
  log?: (line: string) => void
}

export type NotifyOutcome =
  | { status: "sent"; notice: TradeNotice; to_user: string }
  | { status: "skipped"; reason: "no_other_side" | "no_email" | "unsubscribed" | "optout_unknown" | "no_names" }
  | { status: "failed"; error: string }

async function defaultLookupEmail(db: SupabaseClient, userId: string): Promise<string | null> {
  const { data, error } = await db.auth.admin.getUserById(userId)
  if (error) throw new Error(`auth read failed: ${error.message}`)
  const email = data?.user?.email?.trim() ?? ""
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null
}

/**
 * Email the side that is NOT `actorUserId`. Never throws; the outcome is for the log.
 * Call it from `after()` so the action it follows has already answered.
 */
export async function notifyOtherSide(
  db: SupabaseClient,
  loaded: LoadedRoom,
  actorUserId: string,
  notice: TradeNotice,
  deps: NotifyDeps = {},
): Promise<NotifyOutcome> {
  const log = deps.log ?? ((line: string) => console.log(line))
  const send = deps.send ?? sendViaResend
  const lookupEmail = deps.lookupEmail ?? defaultLookupEmail
  const code = loaded.room.code
  try {
    const other = loaded.sides.find((s) => s.user_id !== actorUserId)
    if (!other) return { status: "skipped", reason: "no_other_side" }
    const email = await lookupEmail(db, other.user_id)
    if (!email) {
      log(`[trade-room/notify] room=${code} notice=${notice} skipped: no email on the account`)
      return { status: "skipped", reason: "no_email" }
    }
    // Opt-out, fail closed: an unreadable opt-out state is a skip, never a send.
    const { data: sub, error: subErr } = await db.from("email_subscribers").select("unsubscribed_at").eq("email", email).maybeSingle()
    if (subErr) {
      log(`[trade-room/notify] room=${code} notice=${notice} skipped: opt-out read failed (${subErr.message})`)
      return { status: "skipped", reason: "optout_unknown" }
    }
    if (sub && (sub as { unsubscribed_at: string | null }).unsubscribed_at) return { status: "skipped", reason: "unsubscribed" }
    let names: Map<string, string>
    try {
      names = await usernamesFor(db, [actorUserId])
    } catch (e) {
      log(`[trade-room/notify] room=${code} notice=${notice} skipped: ${e instanceof Error ? e.message : String(e)}`)
      return { status: "skipped", reason: "no_names" }
    }
    const mail = buildTradeNoticeEmail(notice, { code, other: names.get(actorUserId) ?? "A collector" })
    const res = await send({ from: WELCOME_FROM_ADDRESS, to: email, ...mail })
    if (!res.ok) {
      log(`[trade-room/notify] room=${code} notice=${notice} send failed: ${res.error}`)
      return { status: "failed", error: res.error }
    }
    log(`[trade-room/notify] room=${code} notice=${notice} sent`)
    return { status: "sent", notice, to_user: other.user_id }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    log(`[trade-room/notify] room=${code} notice=${notice} failed: ${error}`)
    return { status: "failed", error }
  }
}
