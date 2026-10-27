// lib/candy/edition-printings.ts
//
// Candy MLB (Top Shot parity, 2026-10-26): the edition page's "Parallel Printings"
// ladder. Top Shot builds it from `setID:playID::subID` keys (the market bundle's
// subedition_siblings); Candy has no such key — a Candy player's printings are
// separate editions of the same `player_id`: the /250 base card and, for five
// players, five /15 Rainbow colours (the colour lives in `editions.badges`,
// read by parallelLabelFromBadges). Without this ladder a Rainbow page showed its
// sibling colours only inside "More <player> & <set> Editions", mixed with other
// players.
//
// THREE STATES: a failed read returns ok:false and the section renders nothing
// (no ladder is a layout choice, never a claim); a player with one printing
// returns ok:true with ≤1 row and the section self-hides.

import { supabaseAdmin } from "@/lib/supabase"
import { apiReadTimeoutMs } from "@/lib/api/bounded-read"
import { withQueryDeadline } from "@/lib/analytics/rpc-with-retry"
import { parallelLabelFromBadges } from "@/lib/edition-parallel"

const CANDY_COLLECTION_ID = "209ade70-32c5-4470-bc7c-4793d660f713"

export interface CandyPrinting {
  id: string
  externalId: string
  /** "Base" for the /250 card, else the Rainbow colour badge (e.g. "Rainbow (Blue)"). */
  label: string
  circulation: number | null
  thumbnailUrl: string | null
  fmvUsd: number | null
  isSelf: boolean
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any
type SelfRows = Array<{ player_id: string | null }>
type SibRows = Array<Record<string, unknown>>
type FmvRows = Array<{ edition_id: string; fmv_usd: unknown }>

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

export async function fetchCandyPrintings(
  editionId: string,
  injected?: Db,
): Promise<{ ok: boolean; printings: CandyPrinting[] }> {
  const db: Db = injected ?? supabaseAdmin
  try {
    const self = await withQueryDeadline<SelfRows>(
      db.from("editions").select("player_id").eq("id", editionId).eq("collection_id", CANDY_COLLECTION_ID).limit(1),
      "edition/candy-printings-self",
      apiReadTimeoutMs(),
    )
    if (self.error) return { ok: false, printings: [] }
    const playerId = (self.data ?? [])[0]?.player_id ?? null
    if (!playerId) return { ok: true, printings: [] }
    const sibs = await withQueryDeadline<SibRows>(
      db.from("editions")
        .select("id,external_id,badges,circulation_count,thumbnail_url")
        .eq("collection_id", CANDY_COLLECTION_ID)
        .eq("player_id", playerId)
        .order("circulation_count", { ascending: false })
        .order("external_id", { ascending: true })
        .limit(20),
      "edition/candy-printings",
      apiReadTimeoutMs(),
    )
    if (sibs.error) return { ok: false, printings: [] }
    const rows = (sibs.data ?? []).filter((r) => typeof r.id === "string" && typeof r.external_id === "string")
    if (rows.length < 2) return { ok: true, printings: [] }
    const fmv = await withQueryDeadline<FmvRows>(
      db.from("candy_fmv_current").select("edition_id,fmv_usd").in("edition_id", rows.map((r) => r.id as string)),
      "edition/candy-printings-fmv",
      apiReadTimeoutMs(),
    )
    // A failed FMV read keeps the ladder (names, mints, links are facts) with no prices — never $0.
    const fmvBy = new Map<string, number | null>()
    if (!fmv.error) for (const f of fmv.data ?? []) fmvBy.set(f.edition_id, num(f.fmv_usd))
    return {
      ok: true,
      printings: rows.map((r) => ({
        id: r.id as string,
        externalId: r.external_id as string,
        label: parallelLabelFromBadges(Array.isArray(r.badges) ? (r.badges as string[]) : null) ?? "Base",
        circulation: num(r.circulation_count),
        thumbnailUrl: typeof r.thumbnail_url === "string" ? r.thumbnail_url : null,
        fmvUsd: fmvBy.get(r.id as string) ?? null,
        isSelf: r.id === editionId,
      })),
    }
  } catch {
    return { ok: false, printings: [] }
  }
}
