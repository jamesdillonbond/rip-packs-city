// app/api/packs/chase/route.ts
//
// GET /api/packs/chase?collection=nba-top-shot&tier=legendary|ultimate|rare
//                     &sort=now|vsLaunch|remaining&buyableOnly=true&limit=<n>
//
// Backs the "Chase left" view on the Top Shot packs board: for each dist with
// packs still sealed, how many moments of the chosen tier remain inside them and
// how today's density compares to launch. Math + honesty rules:
// lib/packs/chase-odds.ts.
//
// TOP SHOT ONLY. The counts come from Dapper's DistributionService via the Atlas
// lane (topshot_atlas_dists); no other collection has a live per-tier remaining
// count. Any other collection is REFUSED with a 400 and no rows — answering it
// with Top Shot's dists would be the substitution defect (CLAUDE.md "Honesty").
//
// Both reads are PAGED to completion on a unique key and a failed page fails the
// whole response: a partial list ranked as if complete would put a "top chase"
// at the head of a list missing the rows that beat it.

import { NextRequest, NextResponse } from "next/server"
import { apiErrorResponse } from "@/lib/api-error"
import { boundedRead } from "@/lib/api/bounded-read"
import { supabaseAdmin } from "@/lib/supabase"
import { COLLECTION_UUID_BY_SLUG } from "@/lib/collections"
import { EV_SNAPSHOT_MAX_AGE_HOURS } from "@/lib/pack-dist-verdict"
import { ownLookup } from "@/lib/safe-lookup"
import { asOfObservedFloors } from "@/lib/pack-dist/observed-as-of"
import {
  buildChaseRows,
  parseChaseSort,
  parseChaseTier,
  CHASE_MAX_AGE_DAYS,
  type AtlasChaseInput,
  type PackMetaInput,
} from "@/lib/packs/chase-odds"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sb: any = supabaseAdmin

const PAGE = 1000
// Hard stop on paging: Top Shot has ~5.3k Atlas dists (read 2026-11-01). A loop
// that reaches this has stopped making progress; refuse rather than spin.
const MAX_PAGES = 12

const TOP_SHOT_SLUGS = new Set(["nba-top-shot", "nba_top_shot"])

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readAllPages<T>(build: (from: number, to: number) => PromiseLike<any>, label: string): Promise<T[]> {
  const out: T[] = []
  for (let page = 0; page < MAX_PAGES; page++) {
    const from = page * PAGE
    const { data, error } = await boundedRead(build(from, from + PAGE - 1), label)
    if (error) throw error
    const rows = (data ?? []) as T[]
    out.push(...rows)
    if (rows.length < PAGE) return out
  }
  throw new Error(`${label}: exceeded ${MAX_PAGES} pages`)
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const collectionRaw = (url.searchParams.get("collection") ?? "").trim()
  if (!collectionRaw) {
    return NextResponse.json({ error: "collection required" }, { status: 400 })
  }
  if (!TOP_SHOT_SLUGS.has(collectionRaw)) {
    return NextResponse.json(
      { error: "Chase odds are published only where live per-tier pack counts exist." },
      { status: 400 },
    )
  }
  const collectionUuid = ownLookup(COLLECTION_UUID_BY_SLUG, "nba-top-shot") ?? null
  if (!collectionUuid) {
    return NextResponse.json({ error: "unknown collection" }, { status: 400 })
  }

  const tier = parseChaseTier(url.searchParams.get("tier"))
  const sort = parseChaseSort(url.searchParams.get("sort"))
  const buyableOnly = (url.searchParams.get("buyableOnly") ?? "").toLowerCase() === "true"
  const limitRaw = parseInt(url.searchParams.get("limit") ?? "60", 10)
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 60

  const nowMs = Date.now()
  const freshCutoff = new Date(nowMs - CHASE_MAX_AGE_DAYS * 86_400_000).toISOString()

  try {
    // The tier filter runs on the jsonb text value: Atlas writes canonical
    // integer strings ("0", "12"), so `> '0'` keeps exactly the non-zero counts.
    // buildChaseRows re-checks numerically either way.
    const atlas = await readAllPages<AtlasChaseInput>(
      (from, to) =>
        sb
          .from("topshot_atlas_dists")
          .select("dist_id, title, summary_fetched_at, unopened_count, total_pack_count, remaining_by_tier, original_by_tier")
          .gt("unopened_count", 0)
          .gte("summary_fetched_at", freshCutoff)
          .gt(`remaining_by_tier->>${tier}`, "0")
          .order("dist_id", { ascending: true })
          .range(from, to),
      "api/packs/chase/topshot_atlas_dists",
    )

    let meta: PackMetaInput[] = []
    if (atlas.length > 0) {
      meta = await readAllPages<PackMetaInput>(
        (from, to) => {
          let q = sb
            .from("pack_table_rows")
            .select("dist_id, title, image_url, primary_available, secondary_available, ev_snapshotted_at, observed_packs_opened")
            .eq("collection_id", collectionUuid)
          if (buyableOnly) {
            const availCutoff = new Date(nowMs - EV_SNAPSHOT_MAX_AGE_HOURS * 3600 * 1000).toISOString()
            q = q.or("primary_available.eq.true,secondary_available.eq.true").gte("ev_snapshotted_at", availCutoff)
          }
          return q.order("dist_id", { ascending: true }).range(from, to)
        },
        "api/packs/chase/pack_table_rows",
      )
    }

    // Floor = opens observed up to each payload's own stamp, re-read only where
    // the all-time count refutes it (lib/pack-dist/observed-as-of.ts).
    const floors = await asOfObservedFloors(sb, atlas, new Map(meta.map((m) => [m.dist_id, m.observed_packs_opened])))
    const metaById = new Map<string, PackMetaInput>()
    for (const m of meta) metaById.set(m.dist_id, { ...m, observed_packs_opened: floors.get(m.dist_id) ?? m.observed_packs_opened })

    const built = buildChaseRows(atlas, metaById, {
      tier,
      sort,
      buyableOnly,
      nowMs,
      availabilityMaxAgeHours: EV_SNAPSHOT_MAX_AGE_HOURS,
    })

    return NextResponse.json(
      {
        rows: built.rows.slice(0, limit),
        total: built.rows.length,
        refuted: built.refuted,
        tier,
        sort,
        buyableOnly,
        limit,
      },
      { headers: { "Cache-Control": "s-maxage=300, stale-while-revalidate=900" } },
    )
  } catch (err) {
    console.error("[packs/chase]", err instanceof Error ? err.message : String(err))
    return apiErrorResponse(err, "api/packs/chase")
  }
}
