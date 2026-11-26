// app/insights/candy-squeeze/page.tsx
//
// PUBLIC INSIGHTS — Candy Listed-Share Squeeze (2026-11-23, Candy parity passes 1–3; the Candy leg of
// /insights/squeeze, /insights/allday-squeeze and /insights/pinnacle-squeeze). Candy has no lock or burn mechanic, so
// its supply squeeze is how few of an edition's collector-held copies carry a live Magic Eden or OpenSea listing (re-seen by RPC's
// sweep within 12 h — the same "confirmed" ask the edition pages use).
//
// This page is the default view: every 2026 Candy set (Base, All-Star Game, Gold, Quest rewards). Every other Candy set
// RPC can vouch for has its own ISR page, /insights/candy-squeeze/set/[setId], reached from the picker. The view lives in
// components/insights/CandySqueezeBoard.tsx; the read is lib/insights/candy-parity-boards.ts.

import CandySqueezeBoard from "@/components/insights/CandySqueezeBoard"
import { fetchBoardForPage } from "@/lib/insights/board-page-fetch"
import { EMPTY_CANDY_SQUEEZE, fetchCandySqueeze } from "@/lib/insights/candy-parity-boards"
import { fetchCandySetBrandIndex } from "@/lib/candy/properties"

// The Candy listings sweeps run every 3 h; refresh at half that.
export const revalidate = 1800

// 25 s, not the shared 8 s (#33). Measured 11-23: ~0.2 s warm (holder counts are precomputed).
const READ_BUDGET_MS = 25_000

export default async function CandySqueezePage() {
  // The brand index only groups the set picker; a failed read leaves the picker ungrouped.
  const [res, brands] = await Promise.all([
    fetchBoardForPage("Candy squeeze", EMPTY_CANDY_SQUEEZE, (db) => fetchCandySqueeze(db), READ_BUDGET_MS),
    fetchCandySetBrandIndex(),
  ])
  return <CandySqueezeBoard ok={res.ok} data={res.data} activeSet={null} brands={brands} />
}
