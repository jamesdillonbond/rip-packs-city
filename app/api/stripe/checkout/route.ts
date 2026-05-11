// POST /api/stripe/checkout — create a Stripe Checkout session for RPC Pro
//
// Authentication required. The user's Supabase auth id is threaded into
// subscription_data.metadata.user_id so the webhook can resolve the
// subscriber via activate_pro_from_stripe even on later renewal invoices.
//
// walletAddress is optional. If supplied (e.g. user already linked a Flow
// wallet on the dashboard), it is also written to metadata so the RPC can
// activate pro_users immediately rather than logging the payment as
// pending.

import { NextRequest, NextResponse } from "next/server"
import { getStripe, PRO_PRICE_ID } from "@/lib/stripe"
import { getCurrentUser } from "@/lib/auth/supabase-server"

export async function POST(req: NextRequest) {
  if (!process.env.STRIPE_SECRET_KEY || !PRO_PRICE_ID) {
    return NextResponse.json({ error: "Stripe not configured" }, { status: 503 })
  }

  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 })
  }

  try {
    const body = await req.json().catch(() => ({}))
    const walletAddress: string | null =
      typeof body?.walletAddress === "string" && body.walletAddress.trim()
        ? body.walletAddress.trim().toLowerCase()
        : null

    const baseUrl = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"

    const metadata: Record<string, string> = { user_id: user.id }
    if (walletAddress) metadata.wallet_address = walletAddress

    const session = await getStripe().checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [{ price: PRO_PRICE_ID, quantity: 1 }],
      customer_email: user.email ?? undefined,
      metadata,
      subscription_data: { metadata },
      success_url: `${baseUrl}/dashboard?pro=success`,
      cancel_url: `${baseUrl}/pricing?pro=cancelled`,
    })

    return NextResponse.json({ url: session.url })
  } catch (err: any) {
    console.log("[stripe/checkout] error:", err.message)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
