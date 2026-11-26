// lib/ufc-aptos-floor.ts
//
// UFC Strike's lowest live ask on Aptos, for the edition page (2026-11-25).
//
// WHY: UFC moved Flow -> Aptos and Rarible is its only venue there. Measured 2026-11-25 PT: Rarible
// recorded 5 purchases across ALL Aptos collections from 09-13 to 11-25 (the last on 10-22), while UFC's
// own store wallet listed 55 Moments 10-19..11-13. Asks are the only live price evidence, so the edition
// page shows the cheapest single-Moment Rarible ask even while RPC still treats UFC's FMV as closed.
//
// SOURCE: v_ufc_aptos_edition_floor (service-role only), fed by scripts/ufc-aptos-listings.mjs, which
// re-checks every stored listing's owner each run and deletes only listings whose token moved elsewhere.
// The buy link is the Rarible COLLECTION page: per-token Rarible links 404 for some real tokens
// (verified 2026-11-15, #733 Geoff Neal).
//
// THREE STATES: a failed read is { ok: false } (render nothing, claim nothing); ok + no single listing
// is { ok: true, floor: null } (render nothing — the lane may not have reached this edition yet, so
// "none listed" would be a claim we cannot back); ok + a listing is the floor.

import { supabaseAdmin } from "@/lib/supabase"
import { apiReadTimeoutMs } from "@/lib/api/bounded-read"
import { withQueryDeadline } from "@/lib/analytics/rpc-with-retry"

export interface UfcAptosFloor {
  floorUsd: number
  floorApt: number | null
  singleListings: number
  checkedAt: string | null
  raribleUrl: string | null
}

type RawRows = { data: unknown; error: unknown }

function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN
  return Number.isFinite(n) ? n : null
}

/** Rarible's collection page for an Aptos collection id (redirects to og.rarible.com). */
export function raribleAptosCollectionUrl(aptosCollectionId: string | null | undefined): string | null {
  if (!aptosCollectionId || !/^0x[0-9a-f]{1,64}$/i.test(aptosCollectionId)) return null
  return `https://rarible.com/collection/aptos/${aptosCollectionId}/items`
}

export async function fetchUfcAptosEditionFloor(
  editionId: string,
  db: any = supabaseAdmin, // eslint-disable-line @typescript-eslint/no-explicit-any
): Promise<{ floor: UfcAptosFloor | null; ok: boolean }> {
  try {
    const [floorRes, collRes] = await Promise.all([
      withQueryDeadline<RawRows>(
        db.from("v_ufc_aptos_edition_floor").select("floor_usd,floor_apt,single_listings,checked_at").eq("edition_id", editionId).limit(1),
        "edition/ufc-aptos-floor",
        apiReadTimeoutMs(),
      ),
      withQueryDeadline<RawRows>(
        db.from("ufc_aptos_collections").select("aptos_collection_id").eq("edition_id", editionId).order("aptos_collection_id", { ascending: true }).limit(1),
        "edition/ufc-aptos-collection",
        apiReadTimeoutMs(),
      ),
    ])
    if (floorRes.error) return { floor: null, ok: false }
    const r = ((floorRes.data ?? []) as Record<string, unknown>[])[0]
    const floorUsd = num(r?.floor_usd)
    if (!r || floorUsd == null || floorUsd <= 0) return { floor: null, ok: true }
    // The collection id only builds the link; a failed read there drops the link, never the ask.
    const c = collRes.error ? undefined : ((collRes.data ?? []) as Record<string, unknown>[])[0]
    return {
      floor: {
        floorUsd,
        floorApt: num(r.floor_apt),
        singleListings: num(r.single_listings) ?? 0,
        checkedAt: typeof r.checked_at === "string" ? r.checked_at : null,
        raribleUrl: raribleAptosCollectionUrl(typeof c?.aptos_collection_id === "string" ? c.aptos_collection_id : null),
      },
      ok: true,
    }
  } catch {
    return { floor: null, ok: false }
  }
}
