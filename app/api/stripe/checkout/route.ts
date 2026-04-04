// POST /api/stripe/checkout — create a Stripe Checkout session for RPC Pro
import { NextRequest, NextResponse } from "next/server"
import { getStripe, PRO_PRICE_ID } from "@/lib/stripe"

export async function POST(req: NextRequest) {
  if (!PRO_PRICE_ID) {
    return NextResponse.json({ error: "Stripe not configured" }, { status: 503 })
  }

  try {
    const { walletAddress } = await req.json()
    if (!walletAddress) {
      return NextResponse.json({ error: "walletAddress is required" }, { status: 400 })
    }

    const baseUrl = process.env.NEXT_PUBLIC_SITE_URL || "https://rip-packs-city.vercel.app"

    const session = await getStripe().checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [{ price: PRO_PRICE_ID, quantity: 1 }],
      metadata: { walletAddress: walletAddress.toLowerCase() },
      success_url: `${baseUrl}/nba-top-shot/overview?pro=success`,
      cancel_url: `${baseUrl}/nba-top-shot/overview?pro=cancelled`,
    })

    return NextResponse.json({ url: session.url })
  } catch (err: any) {
    console.log("[stripe/checkout] error:", err.message)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
