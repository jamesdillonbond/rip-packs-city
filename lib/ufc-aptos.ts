// lib/ufc-aptos.ts
//
// UFC Strike moved from Flow to Aptos (Trevor 2026-11-15: Aptos extends the existing ufc_strike
// collection). The binder shows both halves of a collector's UFC holdings (2026-11-16, gates B
// and C in claude/ufc-reopen-on-aptos-plan-2026-11-16.md):
//   - moments still on Flow, at the edition's current FMV, with FLOW_MIGRATE_NOTE (they cannot
//     trade until migrated: the Flow marketplace closed 2026-05-13);
//   - moments already on Aptos, from /api/ufc/aptos-holdings, labelled "On Aptos".
//
// ⚠ DELIBERATELY SEPARATE FROM lib/market-closed.ts. The reopen flip removes UFC from
// CLOSED_MARKETS (and the DB's market_closed_at); the Flow note must outlive that, because Flow
// moments stay untradeable whether or not the Aptos market is "open" on RPC. So the binder asks
// THIS module, not closedMarket(), whether to value Flow holdings and show the note.

export const FLOW_MIGRATE_NOTE = "Still on Flow — migrate to Aptos to trade"
export const ON_APTOS_LABEL = "On Aptos"

const UFC_SLUGS = new Set(["ufc", "ufc-strike"])

/** True for the UFC Strike binder: Flow holdings at current FMV + an On Aptos section. */
export function isUfcAptosBinder(collectionSlug: string | null | undefined): boolean {
  return !!collectionSlug && UFC_SLUGS.has(collectionSlug)
}
