// app/api/send-digest/route.ts
// Weekly digest sender. Bearer-protected with INGEST_SECRET_TOKEN.
// Pulls verified subscribers with digest_weekly=true, composes a personalized
// HTML email (portfolio summary + market pulse + top deals), and sends via Resend.

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

const TOKEN = process.env.INGEST_SECRET_TOKEN ?? ""
const FROM = "rpc-digest@rippackscity.com"

function fmtUsd(n: number | null | undefined): string {
  if (n == null) return "—"
  if (Math.abs(n) >= 1000) return "$" + Math.round(n).toLocaleString()
  return "$" + Number(n).toFixed(2)
}

type Subscriber = {
  email: string
  wallet_address: string | null
  verification_token: string | null
}

async function buildEmail(origin: string, sub: Subscriber): Promise<{ subject: string; html: string } | null> {
  let portfolio: any = null
  if (sub.wallet_address) {
    const { data } = await (supabaseAdmin as any).rpc("get_cross_collection_portfolio", {
      p_wallet: sub.wallet_address.toLowerCase(),
    })
    portfolio = data ?? null
  }

  const { data: pulse } = await (supabaseAdmin as any).rpc("get_market_pulse_all")
  const { data: deals } = await (supabaseAdmin as any).rpc("get_cross_collection_deals", {
    p_limit: 5,
    p_min_discount: 15,
  })

  const unsubUrl = sub.verification_token
    ? `${origin}/api/subscribe/unsubscribe?token=${sub.verification_token}`
    : `${origin}/profile`

  const portfolioBlock = portfolio && portfolio.collections?.length
    ? `<h3 style="margin-top:24px">Your Portfolio</h3>
       <p><strong>Total FMV:</strong> ${fmtUsd(portfolio.total_fmv)} across ${portfolio.collection_count ?? portfolio.collections.length} collections (${portfolio.total_moments ?? 0} moments)</p>
       ${portfolio.total_pnl != null ? `<p><strong>P&L:</strong> ${portfolio.total_pnl >= 0 ? "+" : ""}${fmtUsd(portfolio.total_pnl)}</p>` : ""}`
    : ""

  const dealsBlock = Array.isArray(deals) && deals.length
    ? `<h3 style="margin-top:24px">Top Deals This Week</h3>
       <ul>${deals.slice(0, 5).map((d: any) =>
         `<li>${d.player_name ?? d.set_name ?? "Listing"} — ${fmtUsd(d.price)} (${d.discount_pct ?? d.pct_below_fmv ?? "?"}% below FMV)</li>`
       ).join("")}</ul>`
    : ""

  const pulseBlock = pulse
    ? `<h3 style="margin-top:24px">Market Pulse</h3><pre style="background:#f5f5f5;padding:10px;font-size:12px;overflow:auto">${JSON.stringify(pulse, null, 2).slice(0, 1500)}</pre>`
    : ""

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#222">
      <h1 style="color:#E03A2F">Rip Packs City — Weekly Digest</h1>
      ${portfolioBlock}
      ${dealsBlock}
      ${pulseBlock}
      <hr style="margin:32px 0;border:none;border-top:1px solid #eee">
      <p style="font-size:11px;color:#888">
        <a href="${origin}/profile">Manage preferences</a> · <a href="${unsubUrl}">Unsubscribe</a>
      </p>
    </div>
  `

  return { subject: "RPC Weekly Digest", html }
}

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? ""
  if (!TOKEN || auth !== `Bearer ${TOKEN}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
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

  for (const sub of subscribers) {
    try {
      const composed = await buildEmail(origin, sub)
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
          subject: composed.subject,
          html: composed.html,
        }),
      })
      if (r.ok) sent += 1
      else errors += 1
    } catch {
      errors += 1
    }
  }

  return NextResponse.json({ subscribers: subscribers.length, sent, errors })
}
