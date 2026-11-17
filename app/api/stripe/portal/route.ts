// POST /api/stripe/portal — redirect Pro subscriber to Stripe billing portal.
//
// Auth-gated (Round 8 Item 2 hardening): the caller must be signed in via
// Supabase cookie auth, and the requested wallet_address must belong to the
// signed-in user — since 2026-10-25 its OWNER (requireOwnedKey), not merely
// any account that saved it. Pre-hardening this route was open —
// anyone who knew a wallet_address could spawn a portal session for it.
// Stripe itself only shows the customer their own data, so the blast radius
// was small, but the auth gate matches /api/stripe/checkout's contract.
import { NextRequest, NextResponse } from "next/server"
import { apiErrorResponse } from "@/lib/api-error";
import { getStripe } from "@/lib/stripe"
import { getCurrentUser } from "@/lib/auth/supabase-server"
import { requireOwnedKey } from "@/lib/auth/owner-key-guard"
import { createClient } from "@supabase/supabase-js"

const supabase: any = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

export async function POST(req: NextRequest) {
  const user = await getCurrentUser()
  if (!user) {
    return NextResponse.json({ error: "Authentication required" }, { status: 401 })
  }

  try {
    const { walletAddress } = await req.json()
    if (!walletAddress || typeof walletAddress !== "string") {
      return NextResponse.json({ error: "walletAddress is required" }, { status: 400 })
    }
    const normalised = walletAddress.trim().toLowerCase()

    // Ownership check (security audit 2026-10-25): the caller must OWN the
    // wallet — its verified saver, else its first saver (lib/auth/owner-key-guard,
    // the #176 rule). "Saved on this account" was not enough: anyone can save any
    // address, and a portal session can cancel the subscription and shows the
    // subscriber's billing email, address and card. Same class as /api/mcp/keys.
    const owned = await requireOwnedKey(normalised)
    if (owned instanceof Response) {
      return NextResponse.json(
        { error: "Wallet is not linked to your account" },
        { status: owned.status === 401 ? 401 : 403 },
      )
    }

    const { data: row } = await supabase
      .from("pro_users")
      .select("stripe_customer_id")
      .eq("wallet_address", normalised)
      .maybeSingle()

    if (!row?.stripe_customer_id) {
      return NextResponse.json({ error: "No active subscription found" }, { status: 404 })
    }

    const baseUrl = process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"

    const session = await getStripe().billingPortal.sessions.create({
      customer: row.stripe_customer_id,
      return_url: `${baseUrl}/nba-top-shot/overview`,
    })

    return NextResponse.json({ url: session.url })
  } catch (err: any) {
    console.log("[stripe/portal] error:", err.message)
    return apiErrorResponse(err, "api/stripe/portal");
  }
}
