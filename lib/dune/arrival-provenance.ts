// lib/dune/arrival-provenance.ts
//
// Row mapping for Dune query 9129294 (held-moment arrival provenance), used by
// app/api/cron/topshot-arrival-provenance-dune. See that route's header.

import { normalizeFlowEventAddress } from "@/lib/address"

const KINDS = new Set(["MP", "LC", "OC", "P", "X", "S", "T", "N"])

/**
 * Dune strips leading zeros from Flow addresses; RPC stores 0x + 16 hex. These are
 * Cadence event fields (Deposit.to / Withdraw.from), so the Flow-event normaliser
 * applies — after checking the value is hex of at most 16 digits.
 */
export function padFlowAddress(raw: unknown): string | null {
  if (raw == null) return null
  const s = String(raw).trim()
  if (!/^(0x)?[0-9a-fA-F]{1,16}$/.test(s)) return null
  return normalizeFlowEventAddress(s)
}

export type ProvenanceRow = {
  wallet: string
  nft_id: string
  arrival_tx: string
  arrival_date: string | null
  block_height: number | null
  kind: string
  price: number | null
  from_addr: string | null
}

/** Map one result row of query 9129294; null when it is not a usable row. */
export function mapProvenanceRow(raw: Record<string, unknown>): ProvenanceRow | null {
  const wallet = padFlowAddress(raw.w)
  const nft = raw.id == null ? "" : String(raw.id)
  const tx = raw.tx == null ? "" : String(raw.tx).toLowerCase()
  const kind = raw.k == null ? "" : String(raw.k)
  if (!wallet || !/^\d+$/.test(nft) || !/^[0-9a-f]{64}$/.test(tx) || !KINDS.has(kind)) return null
  const p = raw.p == null || raw.p === "" ? null : Number(raw.p)
  const h = raw.h == null ? null : Number(raw.h)
  return {
    wallet,
    nft_id: nft,
    arrival_tx: tx,
    arrival_date: raw.dt == null ? null : String(raw.dt).slice(0, 10),
    block_height: h != null && Number.isFinite(h) ? h : null,
    kind,
    price: p != null && Number.isFinite(p) ? p : null,
    from_addr: padFlowAddress(raw.f),
  }
}

