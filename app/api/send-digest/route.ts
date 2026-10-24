// app/api/send-digest/route.ts
// Weekly digest sender. Bearer-protected with INGEST_SECRET_TOKEN.
// DISABLED BY DEFAULT: sends nothing unless SEND_DIGEST_ENABLED === "1" and the
// CAN-SPAM postal address (RPC_SENDER_POSTAL_ADDRESS) is set.
// Pulls verified subscribers with digest_weekly=true, composes a personalized
// HTML + plain-text email (portfolio summary + market pulse + top deals), and sends
// via Resend with a one-click List-Unsubscribe header.

import { NextRequest, NextResponse } from "next/server"
import { normalizeAddress } from "@/lib/address"
import { supabaseAdmin } from "@/lib/supabase"
import { usdSignFirst } from "@/lib/usd-format"
import { commercialSendBlockedReason, commercialSenderLine } from "@/lib/emails/sender-identity"

const TOKEN = process.env.INGEST_SECRET_TOKEN ?? ""
const FROM = "rpc-digest@rippackscity.com"

function fmtUsd(n: number | null | undefined): string {
  const neg = usdSignFirst(n, fmtUsd); if (neg !== null) return neg
  if (n == null) return "—"
  if (Math.abs(n) >= 1000) return "$" + Math.round(n).toLocaleString()
  return "$" + Number(n).toFixed(2)
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

  const portfolioBlock = portfolio && portfolio.collections?.length
    ? `<h3 style="margin-top:24px">Your Portfolio</h3>
       <p><strong>Total FMV:</strong> ${fmtUsd(portfolio.total_fmv)} across ${portfolio.collection_count ?? portfolio.collections.length} collections (${portfolio.total_moments ?? 0} moments)</p>
       ${portfolio.total_pnl != null ? `<p><strong>P&L:</strong> ${portfolio.total_pnl >= 0 ? "+" : ""}${fmtUsd(portfolio.total_pnl)}</p>` : ""}`
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
         `<tr><td style="padding:3px 12px 3px 0">${esc(r.collection_name)}</td><td style="padding:3px 12px 3px 0">${Number(r.sales_24h).toLocaleString()} sales</td><td style="padding:3px 0">${fmtUsd(r.volume_24h)} volume</td></tr>`
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
    lines.push("YOUR PORTFOLIO", `Total FMV: ${fmtUsd(portfolio.total_fmv)} across ${portfolio.collection_count ?? portfolio.collections.length} collections (${portfolio.total_moments ?? 0} moments)`)
    if (portfolio.total_pnl != null) lines.push(`P&L: ${portfolio.total_pnl >= 0 ? "+" : ""}${fmtUsd(portfolio.total_pnl)}`)
    lines.push("")
  }
  if (dealRows.length) {
    lines.push("TOP DEALS THIS WEEK", ...dealRows.slice(0, 5).map((d: any) => `- ${d.player_name ?? d.set_name ?? "Listing"} — ${fmtUsd(d.ask_price)}${d.discount != null ? ` (${d.discount}% below FMV)` : ""}`), "")
  }
  if (pulse24h.length) {
    lines.push("MARKET PULSE — LAST 24 HOURS", ...pulse24h.map((r) => `- ${r.collection_name}: ${Number(r.sales_24h).toLocaleString()} sales, ${fmtUsd(r.volume_24h)} volume`), "")
  }
  lines.push("--", `Manage preferences: ${origin}/profile`, `Unsubscribe: ${unsubUrl}`, commercialSenderLine())

  return { subject: "RPC Weekly Digest", html, text: lines.join("\n"), unsubUrl: sub.verification_token ? unsubUrl : null }
}

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? ""
  if (!TOKEN || auth !== `Bearer ${TOKEN}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  // 2026-10-18: this route had NO enable flag — anything holding the bearer
  // token mailed every verified subscriber a commercial digest with no postal
  // address in it (CAN-SPAM, C2). It is off unless SEND_DIGEST_ENABLED === "1"
  // AND RPC_SENDER_POSTAL_ADDRESS is set; both are checked before any read.
  const blocked = commercialSendBlockedReason(process.env.SEND_DIGEST_ENABLED === "1")
  if (blocked) {
    return NextResponse.json({ sent: 0, skipped: blocked }, { status: 202 })
  }

  const origin = new URL(req.url).origin

  const { data: subs, error } = await (supabaseAdmin as any)
    .from("email_subscribers")
    .select("email, wallet_address, verification_token")
    .eq("verified", true)
    .eq("digest_weekly", true)
    .is("unsubscribed_at", null)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const subscribers: Subscriber[] = subs ?? []
  let sent = 0
  let errors = 0

  const { market, failed: marketFailed } = await readMarket()
  // Either market read failing aborts: a digest silently missing a block is the
  // omission this guard exists to stop, and the next weekly run retries it.
  if (marketFailed.length > 0) {
    return NextResponse.json(
      { error: "market_reads_failed", failed: marketFailed, subscribers: subscribers.length, sent: 0 },
      { status: 503 },
    )
  }

  for (const sub of subscribers) {
    try {
      const composed = await buildEmail(origin, sub, market)
      if (!composed) { errors += 1; continue }
      if (!process.env.RESEND_API_KEY) { errors += 1; continue }

      const r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: FROM,
          to: sub.email,
          reply_to: "rippackscity@gmail.com",
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
      })
      if (r.ok) sent += 1
      else errors += 1
    } catch {
      errors += 1
    }
  }

  return NextResponse.json({ subscribers: subscribers.length, sent, errors, market_reads_failed: marketFailed })
}
