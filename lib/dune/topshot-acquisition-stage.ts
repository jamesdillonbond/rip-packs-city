// lib/dune/topshot-acquisition-stage.ts
//
// Known-issue #190: the row mapper for /api/cron/stage-topshot-acquisitions-dune, kept out of the
// route file (a Next.js route may export only its handlers and segment config).

import { mapProvenanceRow, padFlowAddress, type ProvenanceRow } from "@/lib/dune/arrival-provenance"

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

// ── Transfer-hop lane (#190 step 3) ──────────────────────────────────────────────────────────
// Private temp query 9129613: for each moment that arrived in a saved wallet by a plain transfer
// (no settlement, not a Dapper pack delivery), how the SENDER had acquired it — the sender's own
// latest arrival before the transfer, classified MP/LC/OC/P/N/S/T like the provenance lane.
// REVIEW data: whether a sender's price may stand as the recipient's cost (own account vs gift or
// trade) is Trevor's decision, so nothing here or downstream writes moment_acquisitions.
export const HOP_QUERY_ID = "9129613"

export type HopRow = {
  wallet: string
  nft_id: string
  sender: string
  transfer_date: string | null
  hop_tx: string
  hop_date: string | null
  hop_kind: string
  hop_price: number | null
  hop_from: string | null
  dune_query_id: string
  dune_execution_id: string
}

const HOP_KINDS = new Set(["MP", "LC", "OC", "P", "N", "S", "T"])

export function mapHopRow(raw: Record<string, unknown>, executionId: string): HopRow | null {
  const wallet = padFlowAddress(raw.w)
  const sender = padFlowAddress(raw.f)
  const nft = raw.id == null ? "" : String(raw.id)
  const tx = raw.htx == null ? "" : String(raw.htx).toLowerCase()
  const kind = raw.hk == null ? "" : String(raw.hk)
  if (!wallet || !sender || !/^\d+$/.test(nft) || !/^[0-9a-f]{64}$/.test(tx) || !HOP_KINDS.has(kind)) return null
  const p = raw.hp == null || raw.hp === "" ? null : Number(raw.hp)
  return {
    wallet,
    nft_id: nft,
    sender,
    transfer_date: raw.tdt == null ? null : String(raw.tdt).slice(0, 10),
    hop_tx: tx,
    hop_date: raw.hdt == null ? null : String(raw.hdt).slice(0, 10),
    hop_kind: kind,
    hop_price: p != null && Number.isFinite(p) ? p : null,
    hop_from: padFlowAddress(raw.hf),
    dune_query_id: HOP_QUERY_ID,
    dune_execution_id: executionId,
  }
}
