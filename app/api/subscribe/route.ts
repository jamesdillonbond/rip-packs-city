// app/api/subscribe/route.ts
// POST — create an email_subscribers row + send a Resend verification email.
//
// ⛔ THIS ROUTE IS ANONYMOUS (proxy.ts lists /api/subscribe as public), SO THE
// EMAIL IN THE BODY IS UNPROVEN. Until 2026-10-09 it UPSERTED on email: anyone
// could POST someone else's address and reset that subscriber's `unsubscribed_at`
// to null and `digest_weekly` to true (cron/weekly-digest only skips rows with
// an opt-out, so the victim was mailed again), flip their preferences, attach
// their own wallet, and rotate the token that the victim's unsubscribe links
// carry. Now:
//   - a NEW email gets a row (preferences from the body) and a verification mail;
//   - an EXISTING row is never rewritten by this route. If it is unverified or
//     unsubscribed, the verification mail is re-sent with its EXISTING token
//     (verify/route.ts re-subscribes on click — proof of inbox control), at most
//     once per RESEND_COOLDOWN_MS; a verified, subscribed row gets nothing.
// The response is the same `{ success: true }` either way, so the route does not
// reveal whether an address is subscribed. Preference changes for a known
// address go through the signed-in /api/email/subscribe, pinned to user.email.

import { NextRequest, NextResponse } from "next/server"
import { randomUUID } from "crypto"
import { supabaseAdmin } from "@/lib/supabase"
import { safeApiError, errorLogDetail } from "@/lib/api-error"
import { anonIpKey, bumpAnonRates } from "@/lib/abuse/anon-rate"

const FROM = "rpc-alerts@rippackscity.com"
// One verification mail per address per 10 minutes, however often it is POSTed.
const RESEND_COOLDOWN_MS = 10 * 60 * 1000

type ExistingRow = {
  verified: boolean | null
  unsubscribed_at: string | null
  verification_token: string | null
  updated_at: string | null
}

async function sendVerification(origin: string, email: string, token: string): Promise<void> {
  if (!process.env.RESEND_API_KEY) return
  const verifyUrl = `${origin}/api/subscribe/verify?token=${token}`
  const unsubscribeUrl = `${origin}/api/subscribe/unsubscribe?token=${token}`
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

function failure(err: unknown, where: string) {
  // `success: false` is this route's contract with the two email-capture
  // components, so the shape is kept; only the driver text is dropped.
  console.error(`[api/subscribe] ${where}: ${errorLogDetail(err)}`)
  return NextResponse.json(
    { success: false, ...safeApiError(err, "Couldn't sign you up right now.") },
    { status: 500 }
  )
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown> = {}
  try { body = await req.json() } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }) }

  const email = String(body.email ?? "").trim().toLowerCase()
  if (!email || !/^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(email)) {
    return NextResponse.json({ error: "Invalid email" }, { status: 400 })
  }

  // ⛔ DURABLE CAPS (2026-10-10). Anonymous, and every new address gets a Resend
  // mail; an existing unverified one was re-mailed every 10 minutes forever. So:
  // per IP 10/day, per address 3/day, globally 500/day — FAIL CLOSED. A refusal
  // answers the same `{ success: true }` (the route never reveals whether an
  // address is subscribed) but sends nothing.
  {
    const ip = anonIpKey(req.headers)
    const verdict = await bumpAnonRates([
      ...(ip ? [{ bucket: "subscribe:ip", key: ip, limit: 10, windowSecs: 86400 }] : []),
      { bucket: "subscribe:email", key: email, limit: 3, windowSecs: 86400 },
      { bucket: "subscribe:global", key: "*", limit: 500, windowSecs: 86400 },
    ])
    if (!verdict.allowed) {
      if (verdict.failed) {
        return NextResponse.json({ success: false, error: "Couldn't sign you up right now." }, { status: 503 })
      }
      return NextResponse.json({ success: true })
    }
  }

  const origin = new URL(req.url).origin

  try {
    const { data: existing, error: readErr } = await (supabaseAdmin as any)
      .from("email_subscribers")
      .select("verified, unsubscribed_at, verification_token, updated_at")
      .eq("email", email)
      .maybeSingle()
    if (readErr) return failure(readErr, "lookup failed")

    if (existing) {
      const row = existing as ExistingRow
      const needsConfirm = !row.verified || row.unsubscribed_at != null
      const last = row.updated_at ? Date.parse(row.updated_at) : 0
      const cooledDown = !Number.isFinite(last) || Date.now() - last >= RESEND_COOLDOWN_MS
      if (needsConfirm && cooledDown && row.verification_token) {
        // Only the cooldown clock moves; preferences, opt-out, wallet and token stay.
        const { error: touchErr } = await (supabaseAdmin as any)
          .from("email_subscribers")
          .update({ updated_at: new Date().toISOString() })
          .eq("email", email)
        if (touchErr) return failure(touchErr, "cooldown stamp failed")
        await sendVerification(origin, email, row.verification_token)
      }
      return NextResponse.json({ success: true })
    }

    const walletAddress = body.walletAddress ? String(body.walletAddress).trim().toLowerCase() : null
    const verificationToken = randomUUID()
    const { error: insertErr } = await (supabaseAdmin as any)
      .from("email_subscribers")
      .insert({
        email,
        wallet_address: walletAddress,
        digest_weekly: body.digestWeekly !== false,
        deal_alerts: body.dealAlerts === true,
        badge_alerts: body.badgeAlerts === true,
        portfolio_alerts: body.portfolioAlerts === true,
        verified: false,
        verification_token: verificationToken,
        updated_at: new Date().toISOString(),
      })
    if (insertErr) {
      // A concurrent POST created the row first: that row stands, unchanged.
      if (insertErr.code === "23505") return NextResponse.json({ success: true })
      return failure(insertErr, "insert failed")
    }

    await sendVerification(origin, email, verificationToken)
    return NextResponse.json({ success: true })
  } catch (err) {
    return failure(err, "exception")
  }
}
