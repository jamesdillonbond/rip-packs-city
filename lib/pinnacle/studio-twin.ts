// lib/pinnacle/studio-twin.ts
//
// ONE rule for "this pinnacle_studio_history_v1 row is an on-chain sale recorded again",
// shared by the backfill that decides whether to insert it and the pin page that decides
// whether to show it (10-20 review: the two had drifted — the page matched at ANY distance).

/** Inside ±2 days a missing buyer on either side may still match (#159: median 0.34 h apart). */
export const TWIN_WINDOW_MS = 2 * 86_400_000

/**
 * ⛔ The studio feed's date can run up to ~30 days EARLY (#200, 2026-10-20): 5,804 twins the
 * ±2-day rule missed sat 2–30 days BEFORE their on-chain row — same nft, price and buyer, every
 * pair one-to-one, no other sale of that nft between the two dates. At that distance BOTH buyers
 * must be known and equal, and no other sale of the nft may fall between the two dates (a resale
 * in between makes them two purchases).
 */
export const EARLY_TWIN_WINDOW_MS = 30 * 86_400_000

/** A Flow address compared across feeds: lowercase, no 0x (the studio feed omits it). */
export function normFlowAddr(addr: string | null | undefined): string | null {
  if (!addr) return null
  const a = String(addr).trim().toLowerCase().replace(/^0x/, "")
  return a === "" ? null : a
}

export type TwinSale = { price: number; ms: number; buyer: string | null }

/**
 * PURE. Is the studio row `studio` the same purchase as the non-studio sale `chain` (same nft)?
 * `otherSaleMs` holds the dates of every known sale of that nft; only one strictly between the two
 * dates matters. An undated or unpriced side is never a twin (keep it, never guess).
 */
export function isStudioTwinOf(studio: TwinSale, chain: TwinSale, otherSaleMs: readonly number[]): boolean {
  if (![studio.ms, chain.ms, studio.price, chain.price].every(Number.isFinite)) return false
  if (Math.abs(chain.price - studio.price) >= 1e-9) return false
  if (Math.abs(chain.ms - studio.ms) <= TWIN_WINDOW_MS) {
    return studio.buyer == null || chain.buyer == null || studio.buyer === chain.buyer
  }
  if (studio.buyer == null || chain.buyer == null || studio.buyer !== chain.buyer) return false
  if (!(chain.ms > studio.ms && chain.ms - studio.ms <= EARLY_TWIN_WINDOW_MS)) return false
  return !otherSaleMs.some((m) => m > studio.ms && m < chain.ms)
}
