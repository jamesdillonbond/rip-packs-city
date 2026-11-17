// lib/candy/edition-rarity-label.ts
//
// Candy's OWN rarity name on the edition page (2026-11-13; Trevor, 11-12: "Map it out the way the asset class
// works for this collection itself. We don't need to try to fit these into boxes that don't make sense for
// this collectible"). `editions.rarity_label` (20261112161513) holds the collection's native name — Core,
// Uncommon, Rare, Epic, Titan, Legendary, Unique, Rainbow, Gold … — beside the shared `tier` ladder, which stays
// for cross-collection ranking (Titan → LEGENDARY there). The page shows the native name as its own chip only
// when it says something the tier badge does not ("Titan" beside LEGENDARY, "Core" beside COMMON, "Unique"
// where there is no tier); "Legendary" beside LEGENDARY adds nothing and is omitted.
//
// THREE STATES: a failed read → ok:false and no chip (an absent label claims nothing); read ok and no label →
// no chip; read ok with a label → the chip.

import { supabaseAdmin } from "@/lib/supabase"
import { apiReadTimeoutMs } from "@/lib/api/bounded-read"
import { withQueryDeadline } from "@/lib/analytics/rpc-with-retry"

const CANDY_COLLECTION_ID = "209ade70-32c5-4470-bc7c-4793d660f713"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any

/** The chip text, or null when the native name adds nothing to the tier badge. */
export function nativeRarityChipText(label: string | null | undefined, tier: string | null | undefined): string | null {
  const l = (label ?? "").trim()
  if (!l) return null
  if (tier && l.toLowerCase() === tier.trim().toLowerCase()) return null
  return l
}

export async function fetchCandyRarityLabel(
  editionId: string,
  injected?: Db,
): Promise<{ ok: boolean; label: string | null }> {
  const db: Db = injected ?? supabaseAdmin
  try {
    const res = await withQueryDeadline<Array<{ rarity_label: string | null }>>(
      db.from("editions").select("rarity_label").eq("id", editionId).eq("collection_id", CANDY_COLLECTION_ID).limit(1),
      "edition/candy-rarity-label",
      apiReadTimeoutMs(),
    )
    if (res.error) return { ok: false, label: null }
    return { ok: true, label: (res.data ?? [])[0]?.rarity_label ?? null }
  } catch {
    return { ok: false, label: null }
  }
}
