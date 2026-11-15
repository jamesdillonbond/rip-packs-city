// lib/dune/topshot-acquisition-stage.ts
//
// Known-issue #190: the row mapper for /api/cron/stage-topshot-acquisitions-dune, kept out of the
// route file (a Next.js route may export only its handlers and segment config).

import { mapProvenanceRow, type ProvenanceRow } from "@/lib/dune/arrival-provenance"

// Private temp query (team-owned). The id is not a secret: it is useless without the Dune key,
// which only the dune-proxy worker holds. It must be in the worker's DUNE_ALLOWED_QUERY_IDS.
export const STAGE_QUERY_ID = "9129456"

export type StageRow = {
  wallet: string
  nft_id: string
  acquired_at: string
  tx_hash: string
  price_usd: number
  market: string
  seller: string | null
  dune_query_id: string
  dune_execution_id: string
}

// Dune renders timestamps as "2021-03-01 12:34:56.000 UTC".
function parseDuneTs(s: string): number {
  return Date.parse(s.replace(" UTC", "Z").replace(" ", "T"))
}

// Map one Dune row. null = skipped (reported, never written).
export function mapStageRow(raw: Record<string, unknown>, executionId: string): StageRow | null {
  const wallet = typeof raw.wallet === "string" ? raw.wallet : null
  const nft = raw.nft_id == null ? null : String(raw.nft_id)
  const at = typeof raw.acquired_at === "string" ? raw.acquired_at : null
  const tx = typeof raw.tx_hash === "string" ? raw.tx_hash : null
  const market = typeof raw.market === "string" ? raw.market : null
  const price = typeof raw.price === "number" ? raw.price : Number.NaN
  // Flow addresses are hex; the Dune feed already emits them lowercase. Do not fold here: a
  // value that is not already canonical is a shape we have not seen, so it is skipped.
  if (!wallet || !/^0x[0-9a-f]{16}$/.test(wallet)) return null
  if (!nft || !/^\d+$/.test(nft)) return null
  if (!at || Number.isNaN(parseDuneTs(at))) return null
  if (!tx || !market) return null
  if (!Number.isFinite(price) || price < 0) return null
  const seller = typeof raw.seller === "string" && /^0x[0-9a-f]{16}$/.test(raw.seller) ? raw.seller : null
  return {
    wallet,
    nft_id: nft,
    acquired_at: new Date(parseDuneTs(at)).toISOString(),
    tx_hash: tx,
    price_usd: price,
    market,
    seller,
    dune_query_id: STAGE_QUERY_ID,
    dune_execution_id: executionId,
  }
}


// ── Provenance lane (#190 step 2) ────────────────────────────────────────────────────────────
// Private temp query 9129489: the arrival-provenance classification of Dune query 9129294
// (MP/LC/OC/P/X/S/T/N, see app/api/cron/topshot-arrival-provenance-dune) run ONCE over every
// moment whose latest Deposit is into a saved wallet, instead of 2,000 ids per execution. It feeds
// public.topshot_arrival_provenance; apply_topshot_arrival_provenance() decides what is written.
export const PROVENANCE_QUERY_ID = "9129489"

export function mapProvenanceStageRow(
  raw: Record<string, unknown>,
  executionId: string,
): (ProvenanceRow & { probed_at: string; dune_execution_id: string }) | null {
  const row = mapProvenanceRow(raw)
  if (!row) return null
  return { ...row, probed_at: new Date().toISOString(), dune_execution_id: executionId }
}
