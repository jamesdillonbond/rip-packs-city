// POST /api/stripe/webhook — handle Stripe subscription events
// Provisions and deprovisions RPC Pro in the pro_users table.
//
// invoice.payment_succeeded is the durable event we route through the
// activate_pro_from_stripe SECDEF RPC: it handles idempotency on the
// Stripe event id, writes to stripe_payment_log, and gracefully logs as
// "pending" when the user has not yet linked a Flow wallet.
//
// checkout.session.completed / customer.subscription.updated /
// customer.subscription.deleted continue to handle the immediate
// activation/deactivation path against pro_users directly so we don't
// regress the existing wallet-tied flow.

import { NextRequest, NextResponse } from "next/server"
import { getStripe } from "@/lib/stripe"
import { supabaseAdmin } from "@/lib/supabase"
import { createClient } from "@supabase/supabase-js"

const supabase: any = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET || ""

export async function POST(req: NextRequest) {
  if (!process.env.STRIPE_SECRET_KEY || !endpointSecret) {
    return NextResponse.json({ error: "Stripe not configured" }, { status: 503 })
  }

  const body = await req.text()
  const sig = req.headers.get("stripe-signature") || ""

  let event
  try {
    event = getStripe().webhooks.constructEvent(body, sig, endpointSecret)
  } catch (err: any) {
    console.log("[stripe/webhook] signature verification failed:", err.message)
    return NextResponse.json({ error: "Invalid signature" }, { status: 400 })
  }

  switch (event.type) {
    case "invoice.payment_succeeded": {
      const invoice = event.data.object as any
      const eventId = event.id as string
      const subId = typeof invoice.subscription === "string" ? invoice.subscription : invoice.subscription?.id ?? null
      const customerId = typeof invoice.customer === "string" ? invoice.customer : invoice.customer?.id ?? null
      const amountUsd = (invoice.amount_paid ?? 0) / 100

      const subMeta = invoice.subscription_details?.metadata ?? {}
      const invoiceMeta = invoice.metadata ?? {}
      const userId = subMeta.user_id ?? invoiceMeta.user_id ?? null
      // Accept both walletAddress (camelCase) and wallet_address (snake_case).
      // Lowercase at the read site so the activate RPC always sees the
      // canonical pro_users.wallet_address key shape, regardless of which
      // checkout build wrote the metadata. The RPC also lowercases as a
      // last line of defense.
      const walletRaw =
        subMeta.wallet_address ?? invoiceMeta.wallet_address ?? subMeta.walletAddress ?? invoiceMeta.walletAddress ?? null
      const walletAddress: string | null =
        typeof walletRaw === "string" && walletRaw.trim() ? walletRaw.trim().toLowerCase() : null

      const lineItem = invoice.lines?.data?.[0]
      const planName = lineItem?.price?.nickname ?? lineItem?.description ?? "pro_monthly"
      const periodStart = lineItem?.period?.start
        ? new Date(lineItem.period.start * 1000).toISOString()
        : new Date().toISOString()
      const periodEnd = lineItem?.period?.end
        ? new Date(lineItem.period.end * 1000).toISOString()
        : new Date(Date.now() + 30 * 86400_000).toISOString()

      if (!userId) {
        console.log(`[stripe/webhook] invoice ${eventId} missing user_id metadata, skipping RPC`)
        break
      }

      const { data, error } = await supabaseAdmin.rpc("activate_pro_from_stripe", {
        p_user_id: userId,
        p_wallet_address: walletAddress,
        p_stripe_customer_id: customerId,
        p_stripe_subscription_id: subId,
        p_stripe_event_id: eventId,
        p_amount_usd: amountUsd,
        p_plan_name: planName,
        p_period_start: periodStart,
        p_period_end: periodEnd,
        p_raw_payload: event as object,
      })

      if (error) {
        console.log(`[stripe/webhook] activate_pro_from_stripe error for ${eventId}: ${error.message}`)
        // Paper trail + retryable response. We write a stripe_payment_log
        // row with status='handler_error' so post-mortem can find the
        // failed event without scraping Stripe dashboard, then return 503
        // so Stripe queues an exponential-backoff retry. 500 triggers
        // Stripe's "your endpoint is broken" alarm; 503 is the documented
        // try-again signal.
        try {
          await supabaseAdmin.from("stripe_payment_log").insert({
            user_id: userId,
            wallet_address: walletAddress,
            stripe_customer_id: customerId,
            stripe_subscription_id: subId,
            stripe_event_id: eventId,
            amount_usd: amountUsd,
            plan_name: planName,
            billing_period_start: periodStart,
            billing_period_end: periodEnd,
            status: "handler_error",
            raw_webhook_payload: { event, handler_error: error.message } as object,
          })
        } catch (logErr) {
          console.log(`[stripe/webhook] paper-trail insert failed for ${eventId}:`, logErr instanceof Error ? logErr.message : String(logErr))
        }
        return NextResponse.json(
          { error: "activate_pro_from_stripe failed — Stripe will retry", detail: error.message },
          { status: 503 }
        )
      } else {
        console.log(`[stripe/webhook] activate_pro_from_stripe ${eventId}:`, JSON.stringify(data))
      }
      break
    }

    case "checkout.session.completed": {
      const session = event.data.object as any
      // Accept both walletAddress (camelCase, legacy) and wallet_address
      // (snake_case, current checkout route). Either way, lowercase before
      // any DB write.
      const walletRaw =
        session.metadata?.wallet_address ?? session.metadata?.walletAddress ?? null
      const wallet: string | null =
        typeof walletRaw === "string" && walletRaw.trim() ? walletRaw.trim().toLowerCase() : null
      if (!wallet) break

      const subscriptionId = session.subscription as string
      const sub = await getStripe().subscriptions.retrieve(subscriptionId)
      const periodEnd = new Date((sub as any).current_period_end * 1000).toISOString()

      await supabase.from("pro_users").upsert(
        {
          wallet_address: wallet,
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
