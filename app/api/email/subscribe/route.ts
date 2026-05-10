// app/api/email/subscribe/route.ts
//
// Upsert email_subscribers preferences for the current user and send a
// confirmation email. Auth: Supabase cookie (server-side). The email is
// pinned to the signed-in user's account email — clients can't pass an
// arbitrary `email` field. verification_token defaults to a 32-byte hex
// on insert; we surface it back through a confirmation link.

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { getCurrentUser } from "@/lib/auth/supabase-server"

export const dynamic = "force-dynamic"

const FROM_ADDRESS = "Rip Packs City <noreply@rippackscity.com>"
const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "https://www.rippackscity.com"

interface PrefsBody {
  digest_weekly?: boolean
  deal_alerts?: boolean
  badge_alerts?: boolean
  portfolio_alerts?: boolean
  collection_ids?: string[]
  deal_min_discount?: number
  deal_max_price?: number | null
  deal_tiers?: string[]
  wallet_address?: string | null
}

function buildConfirmationEmail(email: string, token: string): { html: string; text: string } {
  const link = `${SITE_URL}/api/email/confirm?token=${encodeURIComponent(token)}`
  const text = [
    "Confirm your Rip Packs City email subscription.",
    "",
    `Click to confirm: ${link}`,
    "",
    "If you didn't request this, ignore this email.",
  ].join("\n")
  const html = `
    <div style="background:#0a0a0a;color:#fafafa;font-family:system-ui,sans-serif;padding:32px;">
      <div style="max-width:520px;margin:0 auto;background:#18181b;border:1px solid #27272a;border-radius:12px;padding:32px;">
        <h1 style="color:#e55a4c;font-size:24px;margin:0 0 16px;">Confirm your subscription</h1>
        <p style="color:#fafafa;font-size:16px;line-height:1.55;margin:0 0 24px;">
          Click the button below to verify <strong>${email}</strong> and start receiving Rip Packs City alerts based on your preferences.
        </p>
        <p style="margin:0 0 16px;">
          <a href="${link}" style="display:inline-block;background:#e55a4c;color:#0a0a0a;font-weight:700;padding:12px 24px;border-radius:8px;text-decoration:none;">Confirm subscription</a>
        </p>
        <p style="color:rgba(255,255,255,0.45);font-size:13px;line-height:1.5;margin:24px 0 0;">
          If you didn't request this, you can ignore this email.
        </p>
      </div>
    </div>
  `.trim()
  return { html, text }
}

export async function POST(req: NextRequest) {
  const user = await getCurrentUser()
  if (!user || !user.email) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 })
  }

  let body: PrefsBody
  try {
    body = (await req.json()) as PrefsBody
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const email = user.email.toLowerCase()
  const prefs: Record<string, unknown> = {
    email,
    digest_weekly: body.digest_weekly ?? true,
    deal_alerts: body.deal_alerts ?? false,
    badge_alerts: body.badge_alerts ?? false,
    portfolio_alerts: body.portfolio_alerts ?? false,
    wallet_address: body.wallet_address ?? null,
    deal_min_discount: typeof body.deal_min_discount === "number" ? body.deal_min_discount : 20,
    deal_max_price: typeof body.deal_max_price === "number" ? body.deal_max_price : null,
    deal_tiers: Array.isArray(body.deal_tiers) ? body.deal_tiers : null,
    collection_ids: Array.isArray(body.collection_ids) ? body.collection_ids : null,
    unsubscribed_at: null,
  }

  const { data: upserted, error } = await (supabaseAdmin as any)
    .from("email_subscribers")
    .upsert(prefs, { onConflict: "email" })
    .select("id, email, verified, verification_token")
    .maybeSingle()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  if (!upserted) {
    return NextResponse.json({ error: "upsert returned no row" }, { status: 500 })
  }

  let emailSent = false
  let emailError: string | null = null
  if (!upserted.verified) {
    const apiKey = process.env.RESEND_API_KEY
    if (!apiKey) {
      emailError = "RESEND_API_KEY not set"
    } else {
      const { html, text } = buildConfirmationEmail(email, upserted.verification_token)
      try {
        const res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            from: FROM_ADDRESS,
            to: [email],
            subject: "Confirm your Rip Packs City email subscription",
            html,
            text,
          }),
        })
        if (res.ok) {
          emailSent = true
        } else {
          emailError = `Resend HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`
        }
      } catch (err) {
        emailError = err instanceof Error ? err.message : String(err)
      }
    }
  }

  return NextResponse.json({
    ok: true,
    id: upserted.id,
    email: upserted.email,
    verified: !!upserted.verified,
    confirmation_email_sent: emailSent,
    confirmation_email_error: emailError,
  })
}

export async function GET() {
  const user = await getCurrentUser()
  if (!user || !user.email) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 })
  }
  const { data, error } = await (supabaseAdmin as any)
    .from("email_subscribers")
    .select("id, email, verified, wallet_address, digest_weekly, deal_alerts, badge_alerts, portfolio_alerts, collection_ids, deal_min_discount, deal_max_price, deal_tiers, unsubscribed_at")
    .ilike("email", user.email.toLowerCase())
    .maybeSingle()
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ ok: true, subscriber: data ?? null })
}
