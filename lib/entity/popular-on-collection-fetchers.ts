// lib/entity/popular-on-collection-fetchers.ts
//
// The two reads behind `components/entity/PopularOnCollection` — the
// server-rendered internal-link block on each /overview page — lifted out of
// the component 2026-08-17 so a test can drive them. The component was an async
// SERVER component holding its own client, which put it outside the
// server-page ratchet (it walked `page.tsx` only) AND effectively outside the
// component gate, which cannot render an async server component under jsdom.
// Nominally ~29% covered; actually undriveable.
//
// ⚠ WHAT WAS ACTUALLY WRONG, stated precisely rather than dressed up. This
// block cannot lie in WORDS — on a failed read the whole section returns null
// and simply disappears, so no false sentence reaches a reader. What it can do
// is VANISH SILENTLY, and nothing could tell the two apart:
//
//   * `loadHubs` never destructured `error` on either query. It read
//     `Array.isArray(res?.data) ? res.data : []`, which is the documented
//     fabricated-empty shape — supabase-js RETURNS `{data:null,error}` for a
//     statement timeout, so a failed read became an empty list with no trace.
//   * `loadLinks` collapsed both into one branch: `if (error || !Array.isArray(data)) return []`.
//   * Both wrapped everything in `catch { return [] }`.
//
// The component's own header calls these "the high-leverage internal links that
// push crawl depth into the corpus". So a timeout quietly removes the crawl
// path from a server-rendered page that still returns 200 and still looks
// complete — an SEO regression that is unfalsifiable by construction, which is
// the sub-class this repo rates worst because its output is silence.
//
// ⚠ THE FIX IS NOT TO RENDER AN ERROR. An anonymous crawler has no use for a
// degraded notice, and there is no honest user-facing claim to make about
// missing internal links. The fix is to stop DESTROYING the distinction: these
// return `{ data, ok }` so "empty because the collection has none" and "empty
// because the read failed" stay separable, and the caller logs the second.

import { supabaseAdmin } from "@/lib/supabase"
import { getCollectionUuid } from "@/lib/collections"

export type FetchResult<T> = { data: T; ok: boolean; reason?: string }

/** Minimal structural shape so tests can inject without the full client type. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type QueryClient = { from: (table: string) => any }

export type RawHubRows = {
  editions: Array<{ set_name?: string | null; player_name?: string | null; team_name?: string | null }>
  series: Array<{ display_label?: string | null }>
}

export type RawLinkRow = {
  external_id?: string | null
  id?: string | null
  player_name?: string | null
  team_name?: string | null
  play_type?: string | null
  set_name?: string | null
  character_name?: string | null
}

const EMPTY_HUB_ROWS: RawHubRows = { editions: [], series: [] }

/**
 * Bounded, recency-ordered editions sample + the collection's series labels.
 *
 * ⚠ Queries are byte-identical to the ones that lived in the component —
 * columns, filters, ordering (`nullsFirst: false`) and limits. Moving a read
 * is not licence to retune it; a changed `limit` or a dropped secondary sort
 * silently changes which links a crawler sees.
 */
export async function fetchHubRows(
  collection: string,
  client: QueryClient = supabaseAdmin as unknown as QueryClient,
): Promise<FetchResult<RawHubRows>> {
  const uuid = getCollectionUuid(collection)
  // Not a failure: an unknown collection legitimately has no hubs. `ok` stays
  // true so this can never be mistaken for an outage.
  if (!uuid) return { data: EMPTY_HUB_ROWS, ok: true }
  try {
    const [edRes, seriesRes] = await Promise.all([
      client
        .from("editions")
        .select("set_name, player_name, team_name")
        .eq("collection_id", uuid)
        .order("last_updated_at", { ascending: false, nullsFirst: false })
        .limit(1000),
      client.from("collection_series").select("display_label").eq("collection_id", uuid).limit(60),
    ])
    // ⚠ Destructure the error on BOTH. Either one failing makes the result
    // partial, and a partial hub set is exactly what used to render as a
    // complete one.
    const err = edRes?.error ?? seriesRes?.error
    if (err) return { data: EMPTY_HUB_ROWS, ok: false, reason: err.message }
    return {
      data: {
        editions: Array.isArray(edRes?.data) ? edRes.data : [],
        series: Array.isArray(seriesRes?.data) ? seriesRes.data : [],
      },
      ok: true,
    }
  } catch (e) {
    return { data: EMPTY_HUB_ROWS, ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
}

/** The 18 leaf-edition tiles. Pinnacle reads a different table by design. */
export async function fetchLinkRows(
  collection: string,
  client: QueryClient = supabaseAdmin as unknown as QueryClient,
): Promise<FetchResult<RawLinkRow[]>> {
  try {
    if (collection === "disney-pinnacle") {
      const { data, error } = await client
        .from("pinnacle_editions")
        .select("id, character_name, set_name")
        .not("thumbnail_url", "is", null)
        .not("character_name", "is", null)
        .order("mint_count", { ascending: true, nullsFirst: false })
        .limit(18)
      if (error) return { data: [], ok: false, reason: error.message }
      return { data: Array.isArray(data) ? data : [], ok: true }
    }

    const uuid = getCollectionUuid(collection)
    if (!uuid) return { data: [], ok: true }

    // Team moments (player_name null — WNBA Skyline, Season Rewind, ...) carry a
    // team_name + play_type instead of a player; allow them in and render via
    // tileSubject as "{team} {play}". Player moments keep player_name.
    const { data, error } = await client
      .from("editions")
      .select("external_id, player_name, team_name, play_type, set_name")
      .eq("collection_id", uuid)
      .not("thumbnail_url", "is", null)
      .or("player_name.not.is.null,team_name.not.is.null")
      .not("external_id", "is", null)
      .order("circulation_count", { ascending: true, nullsFirst: false })
      .limit(18)
    if (error) return { data: [], ok: false, reason: error.message }
    return { data: Array.isArray(data) ? data : [], ok: true }
  } catch (e) {
    return { data: [], ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
}
