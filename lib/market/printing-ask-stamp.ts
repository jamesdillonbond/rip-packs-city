// lib/market/printing-ask-stamp.ts
//
// WHEN a Top Shot PARALLEL's ask last changed (2026-10-21, #206 f). Server only.
//
// ⚠ get_edition_high_offer returns ONE `updated_at`, and for a `::` (parallel) edition it describes
// the OFFER it returns (`par.at` / `chain_ed.at`), not `low_ask` — which comes from the printing's
// own `edition_offers` row. Both the edition page and the moment page dated the ask with it, so
// /moment/52193764 read "Top Shot ask $915 · 5h old" for an ask last changed 6 days earlier, whose
// listing had SOLD. The ask's own stamp is that row's `low_ask_confirmed_at` — when the ask itself was last
// checked. (2026-10-27: it was the row's `updated_at`, which sync_edition_offers_from_atlas also bumps on an
// OFFER-only change, so 150 of 4,221 parallel asks read 1 h+ fresher than they were. A check time is labelled
// "checked", not "changed": callers pass PRINTING_ASK_STAMP_KIND.)
//
// THREE STATES: `ok: false` on a failed read (the page then renders NO age — an unknown age is never
// a fresh one), `at: null` when the row is absent or carries no ask.

import { supabaseAdmin } from "@/lib/supabase"
import { withQueryDeadline } from "@/lib/analytics/rpc-with-retry"
import { apiReadTimeoutMs } from "@/lib/api/bounded-read"

export interface PrintingAskStamp {
  at: string | null
  ok: boolean
}

/** The stamp below is a CHECK time (low_ask_confirmed_at), never a change time. */
export const PRINTING_ASK_STAMP_KIND = "checked" as const

export function isParallelExternalId(externalId: string | null | undefined): boolean {
  return typeof externalId === "string" && externalId.includes("::")
}

export async function fetchPrintingAskChangedAt(
  collectionId: string,
  externalId: string,
  db: any = supabaseAdmin, // eslint-disable-line @typescript-eslint/no-explicit-any
): Promise<PrintingAskStamp> {
  if (!collectionId || !isParallelExternalId(externalId)) return { at: null, ok: true }
  try {
    const { data, error } = await withQueryDeadline<{ low_ask?: unknown; low_ask_confirmed_at?: unknown }>(
      db
        .from("edition_offers")
        .select("low_ask, low_ask_confirmed_at")
        .eq("collection_id", collectionId)
        .eq("external_id", externalId)
        .maybeSingle(),
      "printing-ask-stamp",
      apiReadTimeoutMs(),
    )
    if (error) return { at: null, ok: false }
    const row = data
    if (!row || row.low_ask == null || typeof row.low_ask_confirmed_at !== "string") return { at: null, ok: true }
    return { at: row.low_ask_confirmed_at, ok: true }
  } catch {
    return { at: null, ok: false }
  }
}
