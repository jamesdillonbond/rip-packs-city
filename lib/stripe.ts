// lib/stripe.ts — lazy Stripe client
import Stripe from "stripe"

let _stripe: Stripe | null = null

export function getStripe(): Stripe {
  if (!process.env.STRIPE_SECRET_KEY) {
    throw new Error("STRIPE_SECRET_KEY not configured")
  }
  if (!_stripe) {
    _stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
      apiVersion: "2025-03-31.basil",
      typescript: true,
    })
  }
  return _stripe
}

/**
 * The Stripe Price ID for the RPC Pro monthly subscription.
 * Set this in your Stripe dashboard and env vars.
 */
export const PRO_PRICE_ID = process.env.STRIPE_PRO_PRICE_ID || ""
