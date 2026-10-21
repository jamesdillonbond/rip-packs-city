// lib/pack-drops-sale-state.ts
//
// Client-safe (no server imports): shared by lib/pack-drops-board.ts and the
// /insights/pack-drops client, so "can it be bought now" has one definition.

export type VaultopolisSaleState = {
  listed: number | null
  sold: number | null
  total: number | null
  saleOpen: boolean | null
  soldOut: boolean | null
  saleStartsAt?: string | null
}

/**
 * PURE. Can a pack from this drop be bought right now? 2026-10-20 live sweep: the
 * board read "Sale open 6 · RPC ≥ ask 6" and "~$X vs ~$Y to buy — RPC FMV exceeds
 * the ask" on six drops whose sale state was `listed: 0` (four sold out, two test
 * drops with 0 total). `saleOpen` alone is not "buyable". An UNKNOWN sale state
 * (failed read) is not buyable either.
 */
export function isBuyableNow(st: VaultopolisSaleState | null | undefined): boolean {
  return !!st && st.saleOpen === true && st.soldOut !== true && (st.listed == null || st.listed > 0)
}
