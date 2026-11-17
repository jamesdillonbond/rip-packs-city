// Cross-market floor selection — extracted from app/api/edition-floor/route.ts
// (resolveEditionFloor) so the "which marketplace's floor wins" decision is
// unit-testable independently of the live Top Shot GQL + Flowty fetches it sits
// behind. This picks the real-time lowest ask a buyer would pay across venues
// and records which venue it came from; it feeds fmv_snapshots.cross_market_ask.

export type CrossMarketSource = "topshot" | "flowty" | null

export interface CrossMarketFloor {
  crossMarketFloor: number | null
  crossMarketSource: CrossMarketSource
}

/**
 * Choose the lower of the Top Shot and Flowty floors. Ties go to Top Shot (the
 * native venue) via `<=`. When only one venue has a floor, that one wins; when
 * neither does, the floor is null with no source. `null` means "no live ask on
 * that venue" and is treated as absent, not as a zero floor.
 */
export function selectCrossMarketFloor(
  tsFloor: number | null,
  flowtyFloor: number | null,
): CrossMarketFloor {
  if (tsFloor !== null && flowtyFloor !== null) {
    return tsFloor <= flowtyFloor
      ? { crossMarketFloor: tsFloor, crossMarketSource: "topshot" }
      : { crossMarketFloor: flowtyFloor, crossMarketSource: "flowty" }
  }
  if (tsFloor !== null) return { crossMarketFloor: tsFloor, crossMarketSource: "topshot" }
  if (flowtyFloor !== null) return { crossMarketFloor: flowtyFloor, crossMarketSource: "flowty" }
  return { crossMarketFloor: null, crossMarketSource: null }
}
