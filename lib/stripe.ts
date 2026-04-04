// lib/stripe.ts — Stripe client singleton
import Stripe from "stripe"

if (!process.env.STRIPE_SECRET_KEY) {
  console.log("[stripe] STRIPE_SECRET_KEY not set — Stripe features disabled")
}

export const stripe = new Stripe(process.env.STRIPE_SECRET_KEY || "", {
  apiVersion: "2025-03-31.basil",
  typescript: true,
})

/**
 * The Stripe Price ID for the RPC Pro monthly subscription.
 * Set this in your Stripe dashboard and env vars.
 */
export const PRO_PRICE_ID = process.env.STRIPE_PRO_PRICE_ID || ""
