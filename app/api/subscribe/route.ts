// app/api/subscribe/route.ts
// POST — upsert email_subscribers row + send Resend verification email.

import { NextRequest, NextResponse } from "next/server"
import { randomUUID } from "crypto"
import { supabaseAdmin } from "@/lib/supabase"

const FROM = "rpc-alerts@rippackscity.com"

export async function POST(req: NextRequest) {
  let body: Record<string, unknown> = {}
  try { body = await req.json() } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }) }

  const email = String(body.email ?? "").trim().toLowerCase()
  if (!email || !email.includes("@")) {
    return NextResponse.json({ error: "Invalid email" }, { status: 400 })
  }

  const walletAddress = body.walletAddress ? String(body.walletAddress).trim().toLowerCase() : null
  const digestWeekly = body.digestWeekly !== false
  const dealAlerts = body.dealAlerts === true
  const badgeAlerts = body.badgeAlerts === true
  const portfolioAlerts = body.portfolioAlerts === true

  const verificationToken = randomUUID()

  try {
    const { error } = await (supabaseAdmin as any)
      .from("email_subscribers")
      .upsert(
        {
          email,
          wallet_address: walletAddress,
          digest_weekly: digestWeekly,
          deal_alerts: dealAlerts,
          badge_alerts: badgeAlerts,
          portfolio_alerts: portfolioAlerts,
          verified: false,
          verification_token: verificationToken,
          unsubscribed_at: null,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "email" }
      )

    if (error) {
      return NextResponse.json({ success: false, error: error.message }, { status: 500 })
    }

    const origin = new URL(req.url).origin
    const verifyUrl = `${origin}/api/subscribe/verify?token=${verificationToken}`
    const unsubscribeUrl = `${origin}/api/subscribe/unsubscribe?token=${verificationToken}`

    if (process.env.RESEND_API_KEY) {
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: FROM,
          to: email,
          subject: "Confirm your Rip Packs City subscription",
          html: `
            <h2>One more step</h2>
            <p>Click the link below to confirm your subscription to RPC alerts and digests.</p>
            <p><a href="${verifyUrl}">Verify your email →</a></p>
            <p style="color:#888;font-size:12px">If you didn't request this, you can safely ignore this email or <a href="${unsubscribeUrl}">unsubscribe</a>.</p>
          `,
        }),
      }).catch(() => {})
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    )
  }
}
