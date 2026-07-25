// cart-drawer-compute — pure pricing / compatibility / totals logic lifted out
// of components/cart/CartDrawer.tsx so it lands under the vitest coverage
// `include` (lib/**), which does NOT measure components/**. No React/JSX, no
// browser globals — behavior is identical to the inline code it replaced.
//
// Cart is shelved/dormant (Known issues #1) but the code still compiles and is
// imported; extracting its pure math still adds real coverage and pins the
// buy/offer split + balance math against a silent regression.

import type { CartItem, PurchaseStatus } from '@/lib/cart/CartContext'

// $12.50 — the canonical price string used across every cart cell.
export function formatPrice(n: number): string {
  return `$${n.toFixed(2)}`
}

// Pure half of the CartDrawer `fmvDelta` renderer: computes the discount/premium
// label and direction, or null when there's no usable FMV to compare against.
// The component wraps this in the coloured <span>.
export function fmvDeltaLabel(
  price: number,
  fmv: number | null | undefined,
): { label: string; isDiscount: boolean } | null {
  if (!fmv || fmv === 0) return null
  const pct = ((price - fmv) / fmv) * 100
  const isDiscount = pct < 0
  const label = isDiscount
    ? `${Math.abs(pct).toFixed(0)}% below FMV`
    : `${pct.toFixed(0)}% above FMV`
  return { label, isDiscount }
}

// True if a listing requires Dapper Wallet (DUC/FUT payment tokens).
export function isDapperOnly(item: Pick<CartItem, 'paymentToken'>): boolean {
  return item.paymentToken === 'DUC' || item.paymentToken === 'FUT'
}

// True if a listing can be purchased with a Flow Wallet (FLOW / USDC.e).
export function isFlowCompatible(item: Pick<CartItem, 'paymentToken'>): boolean {
  return item.paymentToken === 'FLOW' || item.paymentToken === 'USDC_E'
}

// Per-tier text colour for the cart row tier chip. Falls back to slate for
// unknown / null tiers.
export const CART_TIER_COLORS: Record<string, string> = {
  ULTIMATE: 'text-yellow-400',
  LEGENDARY: 'text-orange-400',
  RARE: 'text-purple-400',
  UNCOMMON: 'text-teal-400',
  FANDOM: 'text-blue-400',
  COMMON: 'text-slate-400',
}

export function cartTierColor(tier: string | null | undefined): string {
  return CART_TIER_COLORS[(tier ?? '').toUpperCase()] ?? 'text-slate-400'
}

// Counts the purchase-run outcome statuses. `failedCount` folds sniped +
// price_changed into "failed or sniped" the way the summary row reads them.
export function countStatuses(
  purchaseStatus: Record<string, PurchaseStatus>,
): { successCount: number; failedCount: number; unavailableCount: number } {
  const values = Object.values(purchaseStatus)
  return {
    successCount: values.filter((s) => s === 'success').length,
    failedCount: values.filter(
      (s) => s === 'failed' || s === 'sniped' || s === 'price_changed',
    ).length,
    unavailableCount: values.filter((s) => s === 'unavailable').length,
  }
}

// Pending = never touched by the run (no status or 'idle'). Split by cartMode
// into buy vs offer lanes.
export function splitPending<T extends Pick<CartItem, 'listingResourceID' | 'cartMode'>>(
  items: T[],
  purchaseStatus: Record<string, PurchaseStatus>,
): { pendingBuyItems: T[]; pendingOfferItems: T[] } {
  const pendingItems = items.filter(
    (i) => !purchaseStatus[i.listingResourceID] || purchaseStatus[i.listingResourceID] === 'idle',
  )
  return {
    pendingBuyItems: pendingItems.filter((i) => i.cartMode !== 'offer'),
    pendingOfferItems: pendingItems.filter((i) => i.cartMode === 'offer'),
  }
}

// When connected with a Flow (non-Dapper) wallet, only Flow-compatible buy items
// can be checked out; the Dapper-only ones are skipped. With a Dapper/unknown
// wallet every pending buy item is buyable and nothing is skipped.
export function selectFlowCompatible<T extends Pick<CartItem, 'paymentToken'>>(
  pendingBuyItems: T[],
  isNonDapper: boolean,
): { flowCompatibleItems: T[]; skippedCount: number } {
  if (!isNonDapper) {
    return { flowCompatibleItems: pendingBuyItems, skippedCount: 0 }
  }
  return {
    flowCompatibleItems: pendingBuyItems.filter((i) => isFlowCompatible(i)),
    skippedCount: pendingBuyItems.filter((i) => isDapperOnly(i)).length,
  }
}

export interface CartTotals {
  // Sum of every pending buy item (both wallet types) — drives the "N buy items"
  // summary row.
  pendingBuyTotal: number
  // Sum of the checkout-eligible (flow-compatible) buy items.
  buyableTotal: number
  // Per-token totals, only meaningful on a Flow wallet (0 otherwise).
  flowItemsTotal: number
  usdcBuyTotal: number
  // Offer lane always settles in USDC.e.
  offerTotal: number
  totalUsdcNeeded: number
  hasFlowItems: boolean
  hasUsdcItems: boolean
}

export function computeCartTotals(
  pendingBuyItems: Pick<CartItem, 'expectedPrice' | 'paymentToken'>[],
  flowCompatibleItems: Pick<CartItem, 'expectedPrice' | 'paymentToken'>[],
  pendingOfferItems: Pick<CartItem, 'offerAmount'>[],
  isNonDapper: boolean,
): CartTotals {
  const pendingBuyTotal = pendingBuyItems.reduce((s, i) => s + i.expectedPrice, 0)
  const buyableTotal = flowCompatibleItems.reduce((s, i) => s + i.expectedPrice, 0)
  const flowItemsTotal = isNonDapper
    ? flowCompatibleItems.filter((i) => i.paymentToken === 'FLOW').reduce((s, i) => s + i.expectedPrice, 0)
    : 0
  const usdcBuyTotal = isNonDapper
    ? flowCompatibleItems.filter((i) => i.paymentToken === 'USDC_E').reduce((s, i) => s + i.expectedPrice, 0)
    : 0
  const offerTotal = pendingOfferItems.reduce((s, i) => s + (i.offerAmount ?? 0), 0)
  const totalUsdcNeeded = usdcBuyTotal + offerTotal
  return {
    pendingBuyTotal,
    buyableTotal,
    flowItemsTotal,
    usdcBuyTotal,
    offerTotal,
    totalUsdcNeeded,
    hasFlowItems: flowItemsTotal > 0,
    hasUsdcItems: usdcBuyTotal > 0 || offerTotal > 0,
  }
}

// Compares the required per-token spend against wallet balances. Both flags are
// false unless there's a matching item type to spend on.
export function checkInsufficientBalance(args: {
  hasFlowItems: boolean
  hasUsdcItems: boolean
  flowItemsTotal: number
  totalUsdcNeeded: number
  flowBalance: number
  usdcBalance: number
}): { insufficientFlow: boolean; insufficientUsdc: boolean } {
  return {
    insufficientFlow: args.hasFlowItems && args.flowItemsTotal > args.flowBalance,
    insufficientUsdc: args.hasUsdcItems && args.totalUsdcNeeded > args.usdcBalance,
  }
}
