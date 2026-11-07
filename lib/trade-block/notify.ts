// lib/trade-block/notify.ts
//
// Trade Block notices (2026-11-02). The block is asynchronous — the collector a proposal
// is FOR is rarely on the page — so three moments email the other person, once each,
// fire-and-forget from the route (`after()`): a PROPOSAL arrived on your listing; your
// proposal was ACCEPTED (with the trade room link when one opened); it was DECLINED; and
// a new listing MATCHES something in an account you proved (at most one a day).
//
// Same rules as the trade room's notices (lib/trade-room/notify.ts):
//   • no wallet address, no asset list, no price/FMV/confidence — username + link only;
//   • a failed send is logged and dropped, never fails the action, never retried;
//   • email_subscribers.unsubscribed_at is honoured, and an unreadable opt-out SKIPS;
//   • the address is read from auth at send time and never stored.

import type { SupabaseClient } from "@supabase/supabase-js"
import { sendViaResend, WELCOME_FROM_ADDRESS, type SendEmailArgs, type SendResult } from "@/lib/welcome/send-account-welcome"
import { usernamesFor } from "@/lib/trade-room/view"
import { bumpAnonRate } from "@/lib/abuse/anon-rate"

export type BlockNotice = "proposal" | "accepted" | "declined" | "match"

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

/** Subject + body for one notice. Pure; no I/O. */
export function buildBlockNoticeEmail(
  notice: BlockNotice,
  opts: { other: string; roomCode?: string | null; listingCode?: string | null },
): { subject: string; html: string; text: string } {
  const other = opts.other.trim() || "A collector"
  let subject: string
  let headline: string
  let body: string
  let cta: string
  let link = `${SITE_URL}/trades/block/mine`
  switch (notice) {
    case "proposal":
      subject = `${other} sent a proposal on your Trade Block listing`
      headline = "New proposal."
      body = `${other} proposed a trade on one of your Trade Block listings. Review what they'd give and accept or decline it on RPC.`
      cta = "Review the proposal"
      break
    case "accepted":
      subject = `${other} accepted your trade proposal`
      headline = "Accepted."
      if (opts.roomCode) {
        link = `${SITE_URL}/trades/${encodeURIComponent(opts.roomCode)}`
        body = `${other} accepted your proposal and a trade room is open for the two of you. Connect your Flow Wallet there, pick the same Moments, and both accept — one transaction, so either everything moves or nothing does.`
        cta = "Open the trade room"
      } else {
        body = `${other} accepted your proposal. Signing it on RPC isn't available for every collection in it yet, so nothing moves from here — the proposal page says which.`
        cta = "See the proposal"
      }
      break
    case "match":
      subject = `${other} is looking for something you hold`
      headline = "A listing fits."
      body = `${other} just posted a Trade Block listing that asks for something in an account you've proved on RPC. See what they'd trade for it — and propose, if it suits you.`
      cta = "See the listing"
      link = opts.listingCode ? `${SITE_URL}/trades/block/${encodeURIComponent(opts.listingCode)}` : `${SITE_URL}/trades/block/mine`
      break
    case "declined":
      subject = `${other} declined your trade proposal`
      headline = "Declined."
      body = `${other} declined your proposal. Nothing moved. Other listings are on the Trade Block.`
      cta = "Browse the Trade Block"
      link = `${SITE_URL}/trades/block`
      break
  }
  const text = `${headline}\n\n${body}\n\n${cta}: ${link}\n\nRip Packs City — ${SITE_URL}`
  const html = `<!doctype html><html><body style="margin:0;padding:0;background:${BG};color:${TEXT};font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${BG};"><tr><td align="center" style="padding:32px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:${PANEL};border:1px solid ${PANEL_BORDER};border-radius:8px;">
<tr><td style="padding:28px 28px 8px;font-size:12px;letter-spacing:0.12em;text-transform:uppercase;color:${ACCENT};font-weight:700;">Rip Packs City · Trade Block</td></tr>
<tr><td style="padding:0 28px 8px;font-size:24px;font-weight:800;color:${TEXT};">${esc(headline)}</td></tr>
<tr><td style="padding:0 28px 20px;font-size:15px;line-height:1.55;color:${TEXT_MUTED};">${esc(body)}</td></tr>
<tr><td style="padding:0 28px 28px;"><a href="${esc(link)}" style="display:inline-block;padding:12px 18px;background:${ACCENT};color:#ffffff;text-decoration:none;font-weight:700;border-radius:6px;font-size:14px;">${esc(cta)} →</a></td></tr>
<tr><td style="padding:0 28px 24px;font-size:12px;line-height:1.5;color:${TEXT_MUTED};">${notice === "match" ? "You get this because you proved an account on the RPC Trade Block. At most one of these a day." : "You get this because of a trade proposal on the RPC Trade Block."} ${esc(SITE_URL)}</td></tr>
</table></td></tr></table></body></html>`
  return { subject, html, text }
}

export interface BlockNotifyDeps {
  send?: (args: SendEmailArgs) => Promise<SendResult>
  lookupEmail?: (db: SupabaseClient, userId: string) => Promise<string | null>
  log?: (line: string) => void
  /** Per (notice, actor, recipient) send budget; default counts durably via bump_anon_action_rate. */
  cooldown?: (db: SupabaseClient, notice: BlockNotice, actorUserId: string, toUserId: string) => Promise<boolean>
}

/**
 * Sends of one notice, from one actor, to one recipient, per hour (2026-11-07
 * review). The trade room fixed this class on 11-04 (CISO M2); the Trade Block
 * had no budget, so propose → withdraw → propose on one listing emailed the
 * lister once per cycle, bounded only by the per-lambda request limiter.
 */
export const BLOCK_NOTICE_COOLDOWN_PER_HOUR = 3

async function defaultCooldown(db: SupabaseClient, notice: BlockNotice, actorUserId: string, toUserId: string): Promise<boolean> {
  const v = await bumpAnonRate(
    { bucket: `trade_block_notice:${notice}`, key: `${actorUserId}:${toUserId}`, limit: BLOCK_NOTICE_COOLDOWN_PER_HOUR, windowSecs: 3600 },
    db as unknown as Parameters<typeof bumpAnonRate>[1],
  )
  return v.allowed
}

export type BlockNotifyOutcome =
  | { status: "sent"; notice: BlockNotice }
  | { status: "skipped"; reason: "no_email" | "unsubscribed" | "optout_unknown" | "no_names" | "self" | "cooldown" }
  | { status: "failed"; error: string }

async function defaultLookupEmail(db: SupabaseClient, userId: string): Promise<string | null> {
  const { data, error } = await db.auth.admin.getUserById(userId)
  if (error) throw new Error(`auth read failed: ${error.message}`)
  const email = data?.user?.email?.trim() ?? ""
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null
}

/** Email `toUserId` about `actorUserId`'s action. Never throws. */
export async function notifyBlock(
  db: SupabaseClient,
  toUserId: string,
  actorUserId: string,
  notice: BlockNotice,
  opts: { roomCode?: string | null; listingCode?: string | null } = {},
  deps: BlockNotifyDeps = {},
): Promise<BlockNotifyOutcome> {
  const log = deps.log ?? ((line: string) => console.log(line))
  const send = deps.send ?? sendViaResend
  const lookupEmail = deps.lookupEmail ?? defaultLookupEmail
  try {
    if (toUserId === actorUserId) return { status: "skipped", reason: "self" }
    const email = await lookupEmail(db, toUserId)
    if (!email) return { status: "skipped", reason: "no_email" }
    const { data: sub, error: subErr } = await db.from("email_subscribers").select("unsubscribed_at").eq("email", email).maybeSingle()
    if (subErr) {
      log(`[trade-block/notify] notice=${notice} skipped: opt-out read failed (${subErr.message})`)
      return { status: "skipped", reason: "optout_unknown" }
    }
    if (sub && (sub as { unsubscribed_at: string | null }).unsubscribed_at) return { status: "skipped", reason: "unsubscribed" }
    // A counter that cannot be read is a skip, never a send (same stance as the opt-out read).
    let allowed = false
    try {
      allowed = await (deps.cooldown ?? defaultCooldown)(db, notice, actorUserId, toUserId)
    } catch (e) {
      log(`[trade-block/notify] notice=${notice} skipped: cooldown read failed (${e instanceof Error ? e.message : String(e)})`)
    }
    if (!allowed) {
      log(`[trade-block/notify] notice=${notice} skipped: cooldown`)
      return { status: "skipped", reason: "cooldown" }
    }
    let names: Map<string, string>
    try {
      names = await usernamesFor(db, [actorUserId])
    } catch (e) {
      log(`[trade-block/notify] notice=${notice} skipped: ${e instanceof Error ? e.message : String(e)}`)
      return { status: "skipped", reason: "no_names" }
    }
    const mail = buildBlockNoticeEmail(notice, { other: names.get(actorUserId) ?? "A collector", roomCode: opts.roomCode, listingCode: opts.listingCode })
    const res = await send({ from: WELCOME_FROM_ADDRESS, to: email, ...mail })
    if (!res.ok) {
      log(`[trade-block/notify] notice=${notice} send failed: ${res.error}`)
      return { status: "failed", error: res.error }
    }
    log(`[trade-block/notify] notice=${notice} sent`)
    return { status: "sent", notice }
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e)
    log(`[trade-block/notify] notice=${notice} failed: ${error}`)
    return { status: "failed", error }
  }
}
