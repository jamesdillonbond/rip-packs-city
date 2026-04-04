// POST /api/stripe/portal — redirect Pro subscriber to Stripe billing portal
import { NextRequest, NextResponse } from "next/server"
import { getStripe } from "@/lib/stripe"
import { createClient } from "@supabase/supabase-js"

const supabase: any = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

export async function POST(req: NextRequest) {
  try {
    const { walletAddress } = await req.json()
    if (!walletAddress) {
      return NextResponse.json({ error: "walletAddress is required" }, { status: 400 })
    }

    const { data: row } = await supabase
      .from("pro_users")
      .select("stripe_customer_id")
      .eq("wallet_address", walletAddress.toLowerCase())
      .maybeSingle()

    if (!row?.stripe_customer_id) {
      return NextResponse.json({ error: "No active subscription found" }, { status: 404 })
    }

    const baseUrl = process.env.NEXT_PUBLIC_SITE_URL || "https://rip-packs-city.vercel.app"

    const session = await getStripe().billingPortal.sessions.create({
      customer: row.stripe_customer_id,
      return_url: `${baseUrl}/nba-top-shot/overview`,
    })

    return NextResponse.json({ url: session.url })
  } catch (err: any) {
    console.log("[stripe/portal] error:", err.message)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
