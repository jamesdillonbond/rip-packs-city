// lib/giveaways/pool-extras.ts
//
// What a giveaway Moment shows beyond its pack row (Trevor, 2026-11-10):
//   - its SET LABEL with the series in front when the set recurs across series
//     ("S1 Base Set", "S3 Metallic Gold LE") — "use the series in front of it";
//   - its official edition BADGES (Rookie Year, Top Shot Debut…) and its
//     SPECIAL SERIAL (#1 / jersey match / perfect mint) — "we should be showing
//     badges / special serial badges on moments in the pack opening, and in the
//     graphics, when it applies".
//
// Badges come from the canonical `get_edition_badge_titles` (the edition page's
// rule, lib/market/canonical-badges.ts); special serials from the canonical
// `specialCats` (lib/badges/glyphs.ts) over editions.circulation_count and
// jersey_number. Never a second copy of either rule.
//
// THREE states per field, never two: a Moment absent from the result (or a
// failed read, `ok:false`) is UNKNOWN and the surface draws nothing extra; an
// entry with `badges: []` was read and genuinely has none. Display only — a
// failed read degrades to the plain set name and no badges, never to a claim.

import type { SupabaseClient } from "@supabase/supabase-js"
import { boundedRead } from "@/lib/api/bounded-read"
import { readCanonicalBadgeTitles } from "@/lib/market/canonical-badges"
import { specialCats, type SpecialCat } from "@/lib/badges/glyphs"
import { SERIES_DISPLAY } from "@/lib/series-label"

export interface MomentExtras {
  set_label: string | null
  badges: string[] | null
  special_serial: SpecialCat[] | null
}

/**
 * A recurring set (minted in more than one series) carries its series in front;
 * a one-series set keeps its plain name. Top Shot series decode through
 * SERIES_DISPLAY (on-chain 0 = Series 1 — the 0↔1 footgun); an unknown series
 * gets no prefix rather than a guessed one.
 */
export function seriesSetLabel(setName: string | null, series: number | null | undefined, recurring: boolean): string | null {
  if (!setName) return null
  if (!recurring || series == null) return setName
  const disp = SERIES_DISPLAY[series]
  if (!disp) return setName
  let m = /^Series (\d{1,2})$/.exec(disp)
  if (m) return `S${m[1]} ${setName}`
  m = /^Series \d{2}(\d{2})-(\d{2})$/.exec(disp)
  if (m) return `'${m[1]}-${m[2]} ${setName}`
  m = /^Summer \d{2}(\d{2})$/.exec(disp)
  if (m) return `Summer '${m[1]} ${setName}`
  return setName
}

type Db = SupabaseClient
type PoolLike = { moment_id: string; edition_key: string | null; set_name: string | null; serial_number: number | null }

/** moment_id → extras for a giveaway pool. Bounded reads; never throws. */
export async function readPoolExtras(db: Db, collectionId: string, pool: readonly PoolLike[]): Promise<Map<string, MomentExtras>> {
  const out = new Map<string, MomentExtras>()
  const keys = [...new Set(pool.map((p) => p.edition_key).filter((k): k is string => !!k))].slice(0, 500)
  if (!collectionId || keys.length === 0) return out
  try {
    const [edsRes, badgeRes] = await Promise.all([
      boundedRead(
        db.from("editions").select("external_id, set_name, series, circulation_count, jersey_number").eq("collection_id", collectionId).in("external_id", keys),
        "giveaways/pool-extras/editions",
      ),
      readCanonicalBadgeTitles(db, collectionId, keys, "giveaways/pool-extras/badges"),
    ])
    const eds = edsRes.error
      ? null
      : new Map(
          ((edsRes.data ?? []) as { external_id: string; set_name: string | null; series: number | null; circulation_count: number | null; jersey_number: number | null }[]).map((e) => [e.external_id, e]),
        )

    // recurring = the set was also minted in another series (one bounded probe per set+series)
    const recurring = new Map<string, boolean>()
    if (eds) {
      for (const e of eds.values()) {
        if (!e.set_name || e.series == null) continue
        const k = `${e.set_name}|${e.series}`
        if (recurring.has(k)) continue
        const other = await boundedRead(
          db.from("editions").select("external_id").eq("collection_id", collectionId).eq("set_name", e.set_name).neq("series", e.series).limit(1),
          "giveaways/pool-extras/recurring-set",
        )
        if (!other.error) recurring.set(k, Array.isArray(other.data) && other.data.length > 0)
      }
    }

    for (const p of pool) {
      const e = p.edition_key && eds ? eds.get(p.edition_key) : undefined
      const rec = e?.set_name != null && e.series != null ? recurring.get(`${e.set_name}|${e.series}`) : undefined
      out.set(p.moment_id, {
        set_label: e && rec !== undefined ? seriesSetLabel(p.set_name ?? e.set_name, e.series, rec) : null,
        badges: badgeRes.ok && p.edition_key ? (badgeRes.titles.get(p.edition_key) ?? []) : null,
        special_serial: e ? specialCats(p.serial_number, e.circulation_count, e.jersey_number) : null,
      })
    }
  } catch (err) {
    console.warn(`[giveaways] pool extras: ${err instanceof Error ? err.message : String(err)}`)
  }
  return out
}
