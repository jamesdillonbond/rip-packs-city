// POST /api/stripe/webhook — handle Stripe subscription events
// Provisions and deprovisions RPC Pro in the pro_users table.

import { NextRequest, NextResponse } from "next/server"
import { stripe } from "@/lib/stripe"
import { createClient } from "@supabase/supabase-js"

const supabase: any = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET || ""

export async function POST(req: NextRequest) {
  const body = await req.text()
  const sig = req.headers.get("stripe-signature") || ""

  let event
  try {
    event = stripe.webhooks.constructEvent(body, sig, endpointSecret)
  } catch (err: any) {
    console.log("[stripe/webhook] signature verification failed:", err.message)
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 })
  }

  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object as any
      const wallet = session.metadata?.walletAddress
      if (!wallet) break

      const subscriptionId = session.subscription as string
      const sub = await stripe.subscriptions.retrieve(subscriptionId)
      const periodEnd = new Date((sub as any).current_period_end * 1000).toISOString()

      await supabase.from("pro_users").upsert(
        {
          wallet_address: wallet.toLowerCase(),
          plan: "monthly",
          stripe_subscription_id: subscriptionId,
          stripe_customer_id: session.customer,
          expires_at: periodEnd,
          subscribed_at: new Date().toISOString(),
        },
        { onConflict: "wallet_address" },
      )
      console.log(`[stripe/webhook] Pro activated for ${wallet}`)
      break
    }

    case "customer.subscription.updated": {
      const sub = event.data.object as any
      const customerId = sub.customer as string

      // Find wallet by customer ID
      const { data: row } = await supabase
        .from("pro_users")
        .select("wallet_address")
        .eq("stripe_customer_id", customerId)
        .maybeSingle()

      if (row) {
        const periodEnd = new Date(sub.current_period_end * 1000).toISOString()
        const active = sub.status === "active" || sub.status === "trialing"
        await supabase
          .from("pro_users")
          .update({
            expires_at: active ? periodEnd : new Date().toISOString(),
          })
          .eq("wallet_address", row.wallet_address)
      }
      break
    }

    case "customer.subscription.deleted": {
      const sub = event.data.object as any
      const customerId = sub.customer as string

      await supabase
        .from("pro_users")
        .update({ expires_at: new Date().toISOString() })
        .eq("stripe_customer_id", customerId)
      console.log(`[stripe/webhook] Pro cancelled for customer ${customerId}`)
      break
    }
  }

  return NextResponse.json({ received: true })
}
