// lib/fmv-capped.ts
//
// #215 — WHICH ASK_ONLY PRICES ARE CAPPED AT SALES. An ASK_ONLY price whose
// algo_version ends `_salescap` / `_histcap` is held to the edition's SALES, so
// "from asks" is the wrong marker for it (fmvBasis(confidence, capped) says
// "capped at sales"). Most read paths that render the marker carry no
// algo_version — the market RPCs, the sniper feed, edition_fmv_current — so this
// module resolves it from the latest snapshot (get_editions_latest_fmv_wide).
//
// ONE RULE, shared by every caller (it was four copies on 10-30): a snapshot
// describes a row ONLY when its price equals the row's price. A newer snapshot,
// or another edition's (a parallel keyed by its base), never lends its flag.
//
// Never throws. Any failed read returns an EMPTY map, and every caller renders
// a missing entry as "not checked" — the marker the row had before #215.

import { supabaseAdmin } from "@/lib/supabase"
import { boundedRead } from "@/lib/api/bounded-read"
import { isSalesCappedAlgo } from "@/lib/fmv-basis"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any

export type CappedCandidate = {
  /** edition UUID (byEditionId) or editions.external_id (byExternalId) */
  key: string | null | undefined
  fmv: number | string | null | undefined
  confidence: string | null | undefined
}

const PRICE_EPSILON = 0.005
const FMV_CHUNK = 500
const EXT_CHUNK = 200

function askOnlyFmvByKey(rows: CappedCandidate[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const r of rows) {
    if (!r.key || r.fmv == null) continue
    if (String(r.confidence ?? "").toUpperCase() !== "ASK_ONLY") continue
    const f = Number(r.fmv)
    if (!Number.isFinite(f) || f <= 0) continue
    if (!out.has(String(r.key))) out.set(String(r.key), f)
  }
  return out
}

/** Edition UUID → capped?, for the ASK_ONLY rows. */
export async function readCappedByEditionId(rows: CappedCandidate[], db: Db = supabaseAdmin): Promise<Map<string, boolean>> {
  const fmvById = askOnlyFmvByKey(rows)
  const out = new Map<string, boolean>()
  const ids = [...fmvById.keys()]
  try {
    for (let i = 0; i < ids.length; i += FMV_CHUNK) {
      const { data, error } = await boundedRead(
        db.rpc("get_editions_latest_fmv_wide", { p_edition_ids: ids.slice(i, i + FMV_CHUNK) }),
        "fmv-capped/get_editions_latest_fmv_wide",
      )
      if (error || !Array.isArray(data)) return new Map()
      for (const snap of data as { edition_id: string; fmv_usd: number | string | null; algo_version: string | null }[]) {
        const id = String(snap.edition_id)
        const f = fmvById.get(id)
        if (f == null || out.has(id)) continue
        if (Math.abs(Number(snap.fmv_usd) - f) > PRICE_EPSILON) continue
        out.set(id, isSalesCappedAlgo(snap.algo_version))
      }
    }
  } catch {
    return new Map()
  }
  return out
}

/** editions.external_id → capped?, for the ASK_ONLY rows of ONE collection. */
export async function readCappedByExternalId(
  collectionId: string,
  rows: CappedCandidate[],
  db: Db = supabaseAdmin,
): Promise<Map<string, boolean>> {
  const fmvByExt = askOnlyFmvByKey(rows)
  const exts = [...fmvByExt.keys()]
  if (exts.length === 0) return new Map()
  const idByExt = new Map<string, string>()
  try {
    // external_id is unique per collection; 200 per request keeps the .in() URL short.
    for (let i = 0; i < exts.length; i += EXT_CHUNK) {
      const { data, error } = await boundedRead(
        db.from("editions").select("id, external_id")
          .eq("collection_id", collectionId).in("external_id", exts.slice(i, i + EXT_CHUNK)).limit(1000),
        "fmv-capped/editions_by_external_id",
      )
      if (error || !Array.isArray(data)) return new Map()
      for (const e of data as { id: string; external_id: string }[]) idByExt.set(String(e.external_id), String(e.id))
    }
  } catch {
    return new Map()
  }
  const byId = await readCappedByEditionId(
    [...idByExt].map(([ext, id]) => ({ key: id, fmv: fmvByExt.get(ext), confidence: "ASK_ONLY" })),
    db,
  )
  const out = new Map<string, boolean>()
  for (const [ext, id] of idByExt) {
    const v = byId.get(id)
    if (v != null) out.set(ext, v)
  }
  return out
}
