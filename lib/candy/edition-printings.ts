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
// SAME CARD, NOT SAME PLAYER (2026-11-26): player + set is not enough. Older Candy sets
// put several DIFFERENT cards of one player in one set ("Play of the Day": "Miguel Cabrera
// gets his 3000th Hit" vs "… Swipes Third Base"; "Kyle Tucker- Past Insert" beside the
// Kyle Tucker Core/Uncommon/Rare ladder), and the ladder listed them all as "Base" printings.
// A printing now shares the edition's card NAME (a Rainbow colour suffix " - BLUE" stripped),
// and is labelled by its Rainbow badge, else Candy's own rarity name (Core, Uncommon, Rare …),
// else "Base". 1,984 multi-printing groups were affected on 11-26, most of them tier ladders.
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
  /** The Rainbow colour badge (e.g. "Rainbow (Blue)"), else Candy's rarity name ("Core", "Epic" …), else "Base". */
  label: string
  circulation: number | null
  thumbnailUrl: string | null
  fmvUsd: number | null
  isSelf: boolean
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = any
type SelfRows = Array<{ player_id: string | null; set_id?: string | null; name?: string | null }>

const RAINBOW_NAME_SUFFIX = /\s+-\s+(?:ORANGE|YELLOW|GREEN|BLUE|PINK)\s*$/i

/** The card a printing belongs to: its name with a Rainbow colour suffix removed. Null when unnamed. */
export function candyCardKey(name: unknown): string | null {
  if (typeof name !== "string") return null
  const k = name.replace(RAINBOW_NAME_SUFFIX, "").trim().replace(/\s+/g, " ").toLowerCase()
  return k || null
}
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
      db.from("editions").select("player_id,set_id,name").eq("id", editionId).eq("collection_id", CANDY_COLLECTION_ID).limit(1),
      "edition/candy-printings-self",
      apiReadTimeoutMs(),
    )
    if (self.error) return { ok: false, printings: [] }
    const playerId = (self.data ?? [])[0]?.player_id ?? null
    // Printings are siblings INSIDE one set (2026-11-08): a player's All-Star or Gold
    // Series ICON is a different card, not a parallel of their Base ICON.
    const setId = (self.data ?? [])[0]?.set_id ?? null
    if (!playerId) return { ok: true, printings: [] }
    let sibQuery = db.from("editions")
      .select("id,external_id,name,badges,rarity_label,circulation_count,thumbnail_url")
      .eq("collection_id", CANDY_COLLECTION_ID)
      .eq("player_id", playerId)
    if (setId) sibQuery = sibQuery.eq("set_id", setId)
    const sibs = await withQueryDeadline<SibRows>(
      sibQuery
        .order("circulation_count", { ascending: false })
        .order("external_id", { ascending: true })
        .limit(20),
      "edition/candy-printings",
      apiReadTimeoutMs(),
    )
    if (sibs.error) return { ok: false, printings: [] }
    // An unnamed self edition keeps the player+set ladder; a named one keeps only its own card.
    const selfKey = candyCardKey((self.data ?? [])[0]?.name)
    const rows = (sibs.data ?? []).filter(
      (r) => typeof r.id === "string" && typeof r.external_id === "string" &&
        (selfKey == null || r.id === editionId || candyCardKey(r.name) === selfKey),
    )
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
        label:
          parallelLabelFromBadges(Array.isArray(r.badges) ? (r.badges as string[]) : null) ??
          (typeof r.rarity_label === "string" && r.rarity_label.trim() ? r.rarity_label.trim() : null) ??
          "Base",
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
