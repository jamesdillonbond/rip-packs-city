// Redeem toast/flash message classifiers — extracted verbatim from
// app/rewards/page.tsx so the redeem success/error copy is exercised by the
// primary coverage gate (which measures lib/** but NOT the app/** page layer).
// Both functions are pure classifications; behaviour is byte-identical to the
// inline if/else + ternary chain they replaced.

// Success toast, tailored to what actually happened server-side:
//   pro       → Pro activated immediately
//   cosmetic  → equipped on profile
//   moment    → gifting flow; copy depends on whether a Top Shot username is
//               already resolved (gift target known vs. needs collecting)
//   merch     → pending manual fulfillment; collect shipping next
//   (default) → generic "track it below"
export function redeemSuccessMessage(
  type: string | null | undefined,
  name: string,
  resolvedTsUsername: string | null | undefined
): string {
  if (type === "pro") {
    return "RPC Pro activated — 30 days. Enjoy."
  } else if (type === "cosmetic") {
    return `Equipped "${name}" on your profile.`
  } else if (type === "moment") {
    return resolvedTsUsername
      ? `Redeemed "${name}". We'll gift it to @${resolvedTsUsername} on Top Shot — track it below.`
      : `Redeemed "${name}". Tell us the Top Shot username to gift it to — track it below.`
  } else if (type === "merch") {
    return `Redeemed "${name}". Add your shipping address so we can send it.`
  } else {
    return `Redeemed "${name}". Track it below.`
  }
}

// Error flash for a non-fatal redeem failure (the `verified_wallet_required`
// gate is handled separately on the page — it is a next-step CTA, not an error).
export function redeemErrorReason(error: string | null | undefined): string {
  return error === "insufficient_credits"
    ? "Not enough Credits."
    : error === "out_of_stock"
    ? "That one's out of stock."
    : error === "status_too_low"
    ? "You haven't reached the required tier yet."
    : error === "per_user_limit_reached"
    ? "You've already redeemed this."
    : "Couldn't redeem that item."
}
