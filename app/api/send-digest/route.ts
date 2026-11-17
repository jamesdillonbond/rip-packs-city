// app/api/send-digest/route.ts
// Weekly digest sender. Bearer-protected with INGEST_SECRET_TOKEN or CRON_SECRET (Vercel cron, Mondays).
// DISABLED BY DEFAULT: sends nothing unless SEND_DIGEST_ENABLED === "1" and the
// CAN-SPAM postal address (RPC_SENDER_POSTAL_ADDRESS) is set.
// Pulls verified subscribers with digest_weekly=true, composes a personalized
// HTML + plain-text email (portfolio summary + market pulse + top deals), and sends
// via Resend with a one-click List-Unsubscribe header.

import { NextRequest, NextResponse } from "next/server"
import { normalizeAddress } from "@/lib/address"
import { supabaseAdmin } from "@/lib/supabase"
import { usdSignFirst } from "@/lib/usd-format"
import { commercialSendBlockedReason, commercialSenderLine, REPLY_TO } from "@/lib/emails/sender-identity"
import { bearerMatches } from "@/lib/auth/bearer-secret"
import { alreadySentEmail, claimEmailDelivery } from "@/lib/email/recipient-guards"

const FROM = "rpc-digest@rippackscity.com"

function fmtUsd(n: number | null | undefined): string {
  const neg = usdSignFirst(n, fmtUsd); if (neg !== null) return neg
  if (n == null) return "—"
  if (Math.abs(n) >= 1000) return "$" + Math.round(n).toLocaleString("en-US")
  return "$" + Number(n).toFixed(2)
}

// " (1,234 moments)", or nothing when the count was not read — never "(0 moments)" (2026-11-03).
function momentsSuffix(n: unknown): string {
  return typeof n === "number" && Number.isFinite(n) ? ` (${n.toLocaleString("en-US")} moments)` : ""
}

// Database text (player / set / collection names) goes into HTML — escape it.
function esc(v: unknown): string {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string)
}

type PulseRow = { collection_name?: string; sales_24h?: number; volume_24h?: number; top_sale_24h?: number | null }

// 2026-10-24: the pulse block used to print `JSON.stringify(pulse)` into a <pre>
// — raw JSON in a customer email. Now one line per collection, and ONLY
// collections that recorded sales: a collection whose feed is frozen (Candy,
// #58) reads 0 here, and "0 sales" in an email would state a fact nobody
// measured.
function pulseRows(pulse: unknown): PulseRow[] {
  return Array.isArray(pulse) ? (pulse as PulseRow[]).filter((r) => (r?.sales_24h ?? 0) > 0) : []
}

// Same bound as alerts-send / weekly-digest (Resend p95 ~1.6 s, one 58 s outlier).
const SEND_TIMEOUT_MS = 10_000

type Subscriber = {
  email: string
  wallet_address: string | null
  verification_token: string | null
}

// The market blocks are the same for every subscriber, so they are read ONCE per
// run. 2026-10-10: each read discarded its error, so a failed read silently
// dropped its block — a failed portfolio read mailed a holder a digest without
// their portfolio, and with every read failing the run mailed every subscriber
// an empty digest. Now: both market reads failing aborts the run before any
// send, and a subscriber whose portfolio read fails is skipped (retried by the
// next run), never mailed a digest that omits it. (Either market read failing
// aborts too — tightened the same night after review.)
type MarketBlocks = { pulse: any; deals: any }

async function readMarket(): Promise<{ market: MarketBlocks; failed: string[] }> {
  const failed: string[] = []
  const { data: pulse, error: pulseErr } = await (supabaseAdmin as any).rpc("get_market_pulse_all")
  if (pulseErr) failed.push("get_market_pulse_all")
  const { data: deals, error: dealsErr } = await (supabaseAdmin as any).rpc("get_cross_collection_deals", {
    p_limit: 5,
    p_min_discount: 15,
  })
  if (dealsErr) failed.push("get_cross_collection_deals")
  return { market: { pulse: pulseErr ? null : pulse, deals: dealsErr ? null : deals }, failed }
}

async function buildEmail(origin: string, sub: Subscriber, market: MarketBlocks): Promise<{ subject: string; html: string; text: string; unsubUrl: string | null } | null> {
  let portfolio: any = null
  if (sub.wallet_address) {
    // ⛔ 2026-09-19 — was `.toLowerCase()`. A folded base58 wallet returns a
    // COMPLETE portfolio object full of zeros, and the template below gates on
    // `collections?.length`, so a Candy holder's weekly email silently dropped
    // their whole portfolio block. An outbound email is the highest-reach
    // surface this class can reach. `normalizeAddress` leaves hex unchanged.
    const { data, error } = await (supabaseAdmin as any).rpc("get_cross_collection_portfolio", {
      p_wallet: normalizeAddress(sub.wallet_address),
    })
    if (error) return null // skipped: a digest without the holder's portfolio is not this email
    portfolio = data ?? null
  }

  const { pulse, deals } = market

  const unsubUrl = sub.verification_token
    ? `${origin}/api/subscribe/unsubscribe?token=${sub.verification_token}`
    : `${origin}/profile`

  // 2026-11-02: total_pnl is summed only over moments with a KNOWN purchase price, and the cross-collection
  // total starts at 0 — so a holder with no known cost was mailed "P&L: +$0.00", and partial coverage read as
  // a whole-portfolio P&L. Print it only when some cost basis is known, and say what it covers.
  const showPnl = portfolio?.total_pnl != null && Number(portfolio?.total_cost_basis) > 0
  const pnlText = showPnl ? `${portfolio.total_pnl >= 0 ? "+" : ""}${fmtUsd(portfolio.total_pnl)} on moments with a known purchase price` : null

  const portfolioBlock = portfolio && portfolio.collections?.length
    ? `<h3 style="margin-top:24px">Your Portfolio</h3>
       <p><strong>Total FMV:</strong> ${fmtUsd(portfolio.total_fmv)} across ${portfolio.collection_count ?? portfolio.collections.length} collections${momentsSuffix(portfolio.total_moments)}</p>
       ${pnlText ? `<p><strong>P&L:</strong> ${pnlText}</p>` : ""}`
    : ""

  const dealRows: any[] = Array.isArray(deals?.deals) ? deals.deals : []
  const dealsBlock = dealRows.length
    ? `<h3 style="margin-top:24px">Top Deals This Week</h3>
       <ul>${dealRows.slice(0, 5).map((d: any) =>
         `<li>${esc(d.player_name ?? d.set_name ?? "Listing")} — ${fmtUsd(d.ask_price)}${d.discount != null ? ` (${esc(d.discount)}% below FMV)` : ""}</li>`
       ).join("")}</ul>`
    : ""

  const pulse24h = pulseRows(pulse)
  const pulseBlock = pulse24h.length
    ? `<h3 style="margin-top:24px">Market Pulse — last 24 hours</h3>
       <table role="presentation" style="border-collapse:collapse;font-size:13px">${pulse24h.map((r) =>
         `<tr><td style="padding:3px 12px 3px 0">${esc(r.collection_name)}</td><td style="padding:3px 12px 3px 0">${Number(r.sales_24h).toLocaleString("en-US")} sales</td><td style="padding:3px 0">${fmtUsd(r.volume_24h)} volume</td></tr>`
       ).join("")}</table>`
    : ""

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#222">
      <h1 style="color:#E03A2F">Rip Packs City — Weekly Digest</h1>
      ${portfolioBlock}
      ${dealsBlock}
      ${pulseBlock}
      <hr style="margin:32px 0;border:none;border-top:1px solid #eee">
      <p style="font-size:11px;color:#888">
        <a href="${origin}/profile">Manage preferences</a> · <a href="${unsubUrl}">Unsubscribe</a><br/>
        ${commercialSenderLine()}
      </p>
    </div>
  `

  // Plain-text part (2026-10-24): HTML-only mail scores worse with spam filters
  // and is unreadable in text-only clients.
  const lines: string[] = ["Rip Packs City — Weekly Digest", ""]
  if (portfolio && portfolio.collections?.length) {
    lines.push("YOUR PORTFOLIO", `Total FMV: ${fmtUsd(portfolio.total_fmv)} across ${portfolio.collection_count ?? portfolio.collections.length} collections${momentsSuffix(portfolio.total_moments)}`)
    if (pnlText) lines.push(`P&L: ${pnlText}`)
    lines.push("")
  }
  if (dealRows.length) {
    lines.push("TOP DEALS THIS WEEK", ...dealRows.slice(0, 5).map((d: any) => `- ${d.player_name ?? d.set_name ?? "Listing"} — ${fmtUsd(d.ask_price)}${d.discount != null ? ` (${d.discount}% below FMV)` : ""}`), "")
  }
  if (pulse24h.length) {
    lines.push("MARKET PULSE — LAST 24 HOURS", ...pulse24h.map((r) => `- ${r.collection_name}: ${Number(r.sales_24h).toLocaleString("en-US")} sales, ${fmtUsd(r.volume_24h)} volume`), "")
  }
  lines.push("--", `Manage preferences: ${origin}/profile`, `Unsubscribe: ${unsubUrl}`, commercialSenderLine())

  return { subject: "RPC Weekly Digest", html, text: lines.join("\n"), unsubUrl: sub.verification_token ? unsubUrl : null }
}

// Monday (UTC) of the week a run falls in — the dedup bucket, so a second call
// in the same week (a re-fired cron, a manual run) never mails anyone twice.
function weekBucket(d: Date): string {
  const day = d.getUTCDay()
  const diff = day === 0 ? -6 : 1 - day
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + diff)).toISOString().slice(0, 10)
}

const PIPELINE_NAME = "send-digest"
const SUBJECT_KEY = "subscriber_digest"
// 2026-11-02: links used `new URL(req.url).origin`, which under a Vercel cron can be a
// *.vercel.app deployment host — every unsubscribe link would then point at a URL
// that changes per deploy. The public site origin is stable.
const ORIGIN = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"

async function logRun(startedAt: string, found: number, sent: number, skipped: number, ok: boolean, err: string | null, extra: Record<string, unknown>) {
  try {
    await (supabaseAdmin as any).rpc("log_pipeline_run", {
      p_pipeline: PIPELINE_NAME, p_started_at: startedAt, p_rows_found: found, p_rows_written: sent,
      p_rows_skipped: skipped, p_ok: ok, p_error: err, p_extra: extra,
    })
  } catch { /* non-fatal */ }
}

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? ""
  // 2026-11-02: CRON_SECRET too — the only credential a Vercel cron can send (vercel.json).
  if (!bearerMatches(auth, "INGEST_SECRET_TOKEN", "CRON_SECRET")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const dry = new URL(req.url).searchParams.get("dry") === "1"
  const startedAt = new Date().toISOString()
  const bucket = weekBucket(new Date())

  // 2026-10-18: this route had NO enable flag — anything holding the bearer
  // token mailed every verified subscriber a commercial digest with no postal
  // address in it (CAN-SPAM, C2). It is off unless SEND_DIGEST_ENABLED === "1"
  // AND RPC_SENDER_POSTAL_ADDRESS is set; both are checked before any read.
  // A dry run (?dry=1) reports COUNTS only — never addresses — and sends nothing.
  const blocked = commercialSendBlockedReason(process.env.SEND_DIGEST_ENABLED === "1")
  if (blocked && !dry) {
    await logRun(startedAt, 0, 0, 0, true, null, { skipped: blocked })
    return NextResponse.json({ sent: 0, skipped: blocked }, { status: 202 })
  }

  const origin = ORIGIN

  const { data: subs, error } = await (supabaseAdmin as any)
    .from("email_subscribers")
    .select("email, wallet_address, verification_token")
    .eq("verified", true)
    .eq("digest_weekly", true)
    .is("unsubscribed_at", null)

  if (error) {
    await logRun(startedAt, 0, 0, 0, false, `subscriber_read: ${error.message}`, { bucket })
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const subscribers: Subscriber[] = subs ?? []
  let sent = 0
  let errors = 0
  let already = 0

  const { market, failed: marketFailed } = await readMarket()
  // Either market read failing aborts: a digest silently missing a block is the
  // omission this guard exists to stop, and the next weekly run retries it.
  if (marketFailed.length > 0) {
    await logRun(startedAt, subscribers.length, 0, subscribers.length, false, `market_reads_failed: ${marketFailed.join(",")}`, { bucket })
    return NextResponse.json(
      { error: "market_reads_failed", failed: marketFailed, subscribers: subscribers.length, sent: 0 },
      { status: 503 },
    )
  }

  if (dry) {
    let wouldSend = 0
    for (const sub of subscribers) {
      const prior = await alreadySentEmail({ ownerKey: sub.email.toLowerCase(), alertKind: "weekly_digest", subjectKey: SUBJECT_KEY, bucket })
      if (prior === null) errors += 1
      else if (prior) already += 1
      else wouldSend += 1
    }
    return NextResponse.json({ dry: true, blocked, bucket, subscribers: subscribers.length, would_send: wouldSend, already_sent_this_week: already, guard_errors: errors, deals: Array.isArray(market.deals?.deals) ? market.deals.deals.length : 0, pulse_rows: pulseRows(market.pulse).length })
  }

  for (const sub of subscribers) {
    try {
      const ownerKey = sub.email.toLowerCase()
      // Fails closed: an unreadable dedup row means "do not send" (retried next run).
      const prior = await alreadySentEmail({ ownerKey, alertKind: "weekly_digest", subjectKey: SUBJECT_KEY, bucket })
      if (prior === null) { errors += 1; continue }
      if (prior) { already += 1; continue }

      const composed = await buildEmail(origin, sub, market)
      if (!composed) { errors += 1; continue }
      if (!process.env.RESEND_API_KEY) { errors += 1; continue }

      // ⛔ CLAIM BEFORE SEND (2026-11-02). The week's delivery row used to be written AFTER the send, with a
      // failed insert only logged — so any rerun that week (a retry, a manual trigger) mailed the subscriber
      // again. Close the window by ORDER: claim the (owner, channel, kind, subject, week) row first, insert-only
      // on its unique key; no row back means another run holds it. `sending` is never drained by alerts-send
      // (claim_pending_deliveries takes only `pending`). A failed send releases the claim so a retry can send;
      // a crash mid-send leaves it held — the safe direction (no duplicate).
      const claim = await claimEmailDelivery({
        ownerKey, alertKind: "weekly_digest", subjectKey: SUBJECT_KEY, bucket,
        log: (m) => console.log(`[${PIPELINE_NAME}] ${m}`),
      })
      if (claim.state === "error") { errors += 1; continue }
      if (claim.state === "held") { already += 1; continue }
      const release = claim.release

      const r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: FROM,
          to: sub.email,
          reply_to: REPLY_TO,
          subject: composed.subject,
          html: composed.html,
          text: composed.text,
          // RFC 8058 one-click unsubscribe (Gmail / Yahoo bulk-sender rule);
          // /api/subscribe/unsubscribe accepts the POST.
          ...(composed.unsubUrl
            ? { headers: { "List-Unsubscribe": `<${composed.unsubUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } }
            : {}),
        }),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      }).catch(async (e) => { await release(); throw e })
      if (!r.ok) { await release(); errors += 1; continue }
      sent += 1
      // A failed mark leaves the claim `sending`, which still blocks a resend this week.
      await claim.markSent()
    } catch {
      errors += 1
    }
  }

  await logRun(startedAt, subscribers.length, sent, already + errors, errors === 0, errors ? `${errors} not sent` : null, { bucket, sent, already_sent_this_week: already, errors })
  return NextResponse.json({ subscribers: subscribers.length, sent, errors, already_sent_this_week: already, market_reads_failed: marketFailed })
}
