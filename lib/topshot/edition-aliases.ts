// lib/topshot/edition-aliases.ts
//
// THE ONE ALIAS POINT for Top Shot edition keys (known-issues #175, migration
// 20261010155627). Top Shot names some printings two ways: the chain mints the
// 2023-24 Honors (Diced) moments as set 152, subedition 0 (`152:<play>`), while
// Top Shot's own API and offer contract name the same moments set 149, parallel 8
// (`149:<play>::8`). The chain key is canonical — every user-held thing (binder
// rows, ownership, sales, the checkpoint) resolves there — and the API-facing
// writers (`app/api/topshot-offers-indexer`, `app/api/cron/offers-sweep`) MUST
// resolve an API key through this table before keying a row, or they mint a
// second edition with its own market and its own (ask-only) FMV, which is what
// the 25 Diced aliases were until 2026-10-10.
//
// `public.topshot_edition_aliases(alias_external_id -> canonical_external_id)`
// is the table; `canonical_topshot_external_id(text)` is its SQL twin.
//
// Honesty: a FAILED read THROWS. Silently answering "no aliases" would key every
// alias offer to the alias edition again — a correct-looking write to the wrong
// row — so the caller decides what a failed read means for its tick (the
// indexer aborts without advancing its cursor; the sweep skips every parallel
// this tick, its existing "never blend" posture).

import { supabaseAdmin } from "@/lib/supabase"

export type TopShotEditionAliasMap = ReadonlyMap<string, string>

// PostgREST caps a page at 1,000 rows. The table holds 25; if it ever reaches
// the cap, a one-page read can no longer prove it is complete, so refuse.
const ALIAS_PAGE_LIMIT = 1000

type Row = { alias_external_id: string; canonical_external_id: string }

export async function fetchTopShotEditionAliases(
  client: { from: (t: string) => any } = supabaseAdmin as unknown as { from: (t: string) => any },
): Promise<TopShotEditionAliasMap> {
  const { data, error } = await client
    .from("topshot_edition_aliases")
    .select("alias_external_id, canonical_external_id")
    .order("alias_external_id", { ascending: true })
    .limit(ALIAS_PAGE_LIMIT)
  if (error) throw new Error(`topshot_edition_aliases read: ${String((error as { message?: unknown }).message ?? error)}`)
  const rows = (data as Row[] | null) ?? []
  if (rows.length >= ALIAS_PAGE_LIMIT) {
    throw new Error(`topshot_edition_aliases read: ${rows.length} rows hit the page cap — the read cannot be proven complete`)
  }
  const map = new Map<string, string>()
  for (const r of rows) {
    if (typeof r.alias_external_id !== "string" || typeof r.canonical_external_id !== "string") continue
    if (r.alias_external_id === r.canonical_external_id) continue
    map.set(r.alias_external_id, r.canonical_external_id)
  }
  // No chains: a canonical that is itself an alias would make resolution depend
  // on iteration order. The migration refuses to seed one; refuse to use one.
  for (const [alias, canonical] of map) {
    if (map.has(canonical)) throw new Error(`topshot_edition_aliases: ${alias} -> ${canonical} -> ${map.get(canonical)} is a chain`)
  }
  return map
}

/** The canonical key for `externalId`, or `externalId` itself when it is not an alias. */
export function canonicalTopShotExternalId(externalId: string, aliases: TopShotEditionAliasMap): string {
  return aliases.get(externalId) ?? externalId
}
