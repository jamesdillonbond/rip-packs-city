// lib/insights/league-scope.ts
//
// Resolve an insights board's `?property=<slug>` (2026-11-26) BEFORE the board is read. A league / brand
// exists only inside Panini or Candy, so the slug is checked against that publisher:
//   · unknown slug, or a collection with no leagues  → { ok:false, kind:"unknown" }      (the route's 400)
//   · the lookup itself failed                       → { ok:false, kind:"unavailable" }  (the board's 5xx)
// — never "no scope", which would serve the whole collection under a league's name.

import { supabaseAdmin } from "@/lib/supabase"
import { boundedRead } from "@/lib/api/bounded-read"
import { cleanScopeSlug } from "@/lib/panini/scope"
import type { TopSalesScope } from "@/lib/insights/top-sales"

export type LeagueScopeResult =
  | { ok: true; scope: TopSalesScope | null }
  | { ok: false; kind: "unknown" }
  | { ok: false; kind: "unavailable"; error: unknown }

type Chain = { select: (c: string) => Chain; eq: (c: string, v: string) => Chain; limit: (n: number) => PromiseLike<unknown> }
type Db = { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<unknown>; from: (t: string) => Chain }

export async function resolveLeagueScope(collection: string | null, raw: string | null | undefined, tag: string, db: Db = supabaseAdmin as unknown as Db): Promise<LeagueScopeResult> {
  const asked = (raw ?? "").trim()
  if (!asked) return { ok: true, scope: null }
  const slug = cleanScopeSlug(asked)
  if (!slug || (collection !== "panini_blockchain" && collection !== "candy_mlb")) return { ok: false, kind: "unknown" }
  if (collection === "panini_blockchain") {
    const ids = await boundedRead(db.rpc("panini_property_set_ids", { p_slug: slug }), `${tag}/panini_property_set_ids`)
    if (ids.error) return { ok: false, kind: "unavailable", error: ids.error }
    const list = (Array.isArray(ids.data) ? ids.data : []).map(Number).filter((n: number) => Number.isSafeInteger(n))
    return list.length === 0 ? { ok: false, kind: "unknown" } : { ok: true, scope: { paniniSetIds: list } }
  }
  const known = await boundedRead(db.from("publisher_properties").select("slug").eq("publisher", "candy").eq("slug", slug).limit(1), `${tag}/candy_property`)
  if (known.error) return { ok: false, kind: "unavailable", error: known.error }
  if (!Array.isArray(known.data)) return { ok: false, kind: "unavailable", error: new Error("candy property lookup returned no list") }
  return known.data.length === 0 ? { ok: false, kind: "unknown" } : { ok: true, scope: { candyProperty: slug } }
}
