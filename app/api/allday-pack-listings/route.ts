import { NextRequest, NextResponse } from "next/server"
import { after } from "next/server"
import { createClient } from "@supabase/supabase-js"
import { normalizePackRetailPrice } from "@/lib/packs/normalize-retail-price"
import { writeInvocationHeartbeat } from "@/lib/pipeline/heartbeat"
import { apiErrorResponse } from "@/lib/api-error"

const supabase: any = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
)

const ALLDAY_COLLECTION_ID = "dee28451-5d62-409e-a1ad-a83f763ac070"
const PIPELINE_NAME = "allday-pack-listings"
const COLLECTION_SLUG = "nfl_all_day"

// OBSERVABILITY (added 2026-08-01). This route had NO log_pipeline_run call of
// any kind, so a live every-20-min ingest was invisible to pipeline_runs,
// detect_stalled_pipelines() and pipeline_cadence_watchlist. It was demonstrably
// working - pack_listings_cache held 281 AllDay rows stamped minutes earlier -
// but that could only be proven from the DESTINATION TABLE, and if it silently
// stopped nothing would have paged.
async function logPipelineRun(args: {
  startedAtIso: string
  ok: boolean
  rowsFound?: number
  rowsWritten?: number
  rowsSkipped?: number
  errorMsg?: string | null
  extra: Record<string, unknown>
}) {
  try {
    const { error } = await supabase.rpc("log_pipeline_run", {
      p_pipeline: PIPELINE_NAME,
      p_started_at: args.startedAtIso,
      p_rows_found: args.rowsFound ?? 0,
      p_rows_written: args.rowsWritten ?? 0,
      p_rows_skipped: args.rowsSkipped ?? 0,
      p_ok: args.ok,
      p_error: args.errorMsg ?? null,
      p_collection_slug: COLLECTION_SLUG,
      p_cursor_before: null,
      p_cursor_after: null,
      p_extra: args.extra,
    })
    if (error) console.log(`[${PIPELINE_NAME}] log_pipeline_run:`, error.message)
  } catch (err) {
    console.log(`[${PIPELINE_NAME}] log_pipeline_run threw:`, err instanceof Error ? err.message : err)
  }
}

const TIER_ENUM = new Set(["COMMON", "UNCOMMON", "RARE", "LEGENDARY", "ULTIMATE"])

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
}

function normalizeTier(raw: string | undefined): string {
  const t = (raw ?? "").toUpperCase().trim()
  if (TIER_ENUM.has(t)) return t
  if (t === "FANDOM") return "UNCOMMON"
  if (t.includes("COMMON")) return "COMMON"
  if (t.includes("UNCOMMON")) return "UNCOMMON"
  if (t.includes("LEGEND")) return "LEGENDARY"
  if (t.includes("ULTIMATE")) return "ULTIMATE"
  if (t.includes("RARE")) return "RARE"
  return "COMMON"
}

export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? ""
  if (auth !== `Bearer ${process.env.INGEST_SECRET_TOKEN}`) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const startedAtIso = new Date().toISOString()

  // Synchronous invocation marker, written BEFORE after() is scheduled. All the
  // real work - including its completion log - happens inside after(), which
  // Vercel is documented to drop (the class that hid the May fmv-recalc stall).
  // Without this marker "no pipeline_runs row" is ambiguous between:
  //   marker only, no completion row -> after() was dropped
  //   no marker at all               -> the route was never reached (cron/auth)
  // Logged ok:true so it cannot inflate v_pipeline_failure_rates.
  // ⚠ 2026-08-20: this marker used to be written under the pipeline's OWN name,
  // and that DEFEATED the alarm it was added to protect. `detect_stalled_pipelines()`
  // computes `max(started_at) FROM pipeline_runs WHERE pipeline = w.pipeline` with
  // NO phase filter, so a self-named marker refreshes `last_run` on every tick —
  // the arm can never fire, however many after() bodies die. Measured across the
  // ~72h retention window: allday-pack-listings had 212 markers against 208
  // completions (6 ticks started and never finished, every one invisible), and
  // pinnacle-sync and compute-laliga-pack-ev had markers ONLY, zero completions.
  // A monitor whose input set includes its own output. The marker now goes under
  // `<pipeline>-heartbeat` via lib/pipeline/heartbeat.ts, which keeps the three
  // states readable AND leaves the stall arm measuring real completions.
  await writeInvocationHeartbeat(
    // `collectionSlug` carried over deliberately: the old marker set it, and a
    // per-collection pipeline whose marker is collection-less reads as "all
    // collections" in any grouped view.
    { pipeline: PIPELINE_NAME, startedAtMs: Date.parse(startedAtIso), collectionSlug: "nfl_all_day" },
    supabase,
  )

  // Fatal-catch wrapper: an uncaught throw inside after() would otherwise write
  // NOTHING, making a genuine crash indistinguishable from a dropped after().
  after(
    runPackListings(startedAtIso).catch(async (err) => {
      const msg = err instanceof Error ? err.message : String(err)
      console.log(`[${PIPELINE_NAME}] fatal:`, msg)
      await logPipelineRun({
        startedAtIso,
        ok: false,
        errorMsg: msg,
        extra: { phase: "complete", failed_at: "uncaught" },
      })
    })
  )

  return NextResponse.json({
    status: "accepted",
    startedAt: startedAtIso,
  })
}

async function runPackListings(startedAtIso: string) {
  const started = Date.now()

  // 1. Fetch editions
  const editionRows: any[] = []
  {
    const pageSize = 1000
    let from = 0
    while (true) {
      const { data, error } = await supabase
        .from("editions")
        .select("id, external_id, set_name, tier, series, player_name")
        .eq("collection_id", ALLDAY_COLLECTION_ID)
        // Deterministic order (PK). Offset paging without one returns some rows on
        // two pages and some on none -- the defect that fabricated 161k buyback rows.
        .order("id", { ascending: true })
        .range(from, from + pageSize - 1)
      if (error) {
        console.log(`[allday-pack-listings] editions fetch error: ${error.message}`)
        await logPipelineRun({
          startedAtIso,
          ok: false,
          errorMsg: `editions fetch: ${error.message}`,
          extra: { phase: "complete", failed_at: "editions_fetch" },
        })
        return
      }
      if (!data || data.length === 0) break
      editionRows.push(...data)
      if (data.length < pageSize) break
      from += pageSize
    }
  }
  console.log(`[allday-pack-listings] Loaded ${editionRows.length} editions`)

  // 2. Fetch cached_listings
  const listingRows: any[] = []
  {
    const pageSize = 1000
    let from = 0
    while (true) {
      const { data, error } = await supabase
        .from("cached_listings")
        .select("id, set_name, tier, ask_price, thumbnail_url, collection_id")
        .eq("collection_id", ALLDAY_COLLECTION_ID)
        .order("id", { ascending: true })
        .range(from, from + pageSize - 1)
      if (error) {
        console.log(`[allday-pack-listings] cached_listings fetch error: ${error.message}`)
        await logPipelineRun({
          startedAtIso,
          ok: false,
          rowsFound: editionRows.length,
          errorMsg: `cached_listings fetch: ${error.message}`,
          extra: { phase: "complete", failed_at: "cached_listings_fetch", editions: editionRows.length },
        })
        return
      }
      if (!data || data.length === 0) break
      listingRows.push(...data)
      if (data.length < pageSize) break
      from += pageSize
    }
  }
  console.log(`[allday-pack-listings] Loaded ${listingRows.length} cached listings`)

  // 3. Build set_name:tier → lowest ask + image + count
  const lowestByGroup = new Map<string, { ask: number; image: string | null; count: number }>()
  for (const row of listingRows) {
    const ask = parseFloat(String(row.ask_price ?? "0"))
    if (!isFinite(ask) || ask <= 0) continue
    const setName: string = (row.set_name ?? "").toString().trim()
    if (!setName) continue
    const tier = normalizeTier(row.tier)
    const key = `${setName}::${tier}`
    const prev = lowestByGroup.get(key)
    if (!prev) {
      lowestByGroup.set(key, { ask, image: row.thumbnail_url ?? null, count: 1 })
    } else {
      prev.count++
      if (ask < prev.ask) prev.ask = ask
      if (!prev.image && row.thumbnail_url) prev.image = row.thumbnail_url
    }
  }

  // 4. Group editions by (set_name, tier)
  type Group = {
    setName: string
    tier: string
    series: number | string | null
    editionCount: number
    listedCount: number
    lowestAsk: number | null
    image: string | null
  }
  const groups = new Map<string, Group>()

  for (const ed of editionRows) {
    const setName: string = (ed.set_name ?? "").toString().trim()
    if (!setName) continue
    const tier = normalizeTier(ed.tier)
    const key = `${setName}::${tier}`
    let g = groups.get(key)
    if (!g) {
      g = { setName, tier, series: ed.series ?? null, editionCount: 0, listedCount: 0, lowestAsk: null, image: null }
      groups.set(key, g)
    }
    g.editionCount++
  }

  for (const [key, g] of groups) {
    const listing = lowestByGroup.get(key)
    if (listing) {
      g.listedCount = listing.count
      g.lowestAsk = listing.ask
      if (!g.image && listing.image) g.image = listing.image
    }
  }

  const groupsFound = groups.size
  const groupsWithListings = Array.from(groups.values()).filter((g) => g.listedCount > 0).length

  const now = new Date().toISOString()
  const rows = Array.from(groups.values())
    .map((g) => {
      const packName = `${g.setName} — ${g.tier}`
      return {
        id: `allday:${slug(`${g.setName}-${g.tier}`)}`,
        collection_id: ALLDAY_COLLECTION_ID,
        pack_name: packName,
        tier: g.tier,
        pack_type: "standard",
        lowest_ask_usd: g.lowestAsk != null ? Math.round(g.lowestAsk * 100) / 100 : null,
        total_listed: g.listedCount,
        moments_per_pack: null as number | null,
        image_url: g.image,
        source: "flowty",
        cached_at: now,
        first_seen_at: now,
        metadata: { edition_count: g.editionCount, series: g.series },
      }
    })

  console.log(`[allday-pack-listings] ${groupsFound} groups, ${groupsWithListings} with listings`)

  console.log('[allday-packs] groups:', rows.slice(0, 5).map(g => ({ id: g.id, pack_name: g.pack_name, tier: g.tier })))

  const del = await supabase
    .from("pack_listings_cache")
    .delete()
    .eq("collection_id", ALLDAY_COLLECTION_ID)
  if (del.error) console.log(`[allday-pack-listings] delete error: ${del.error.message}`)

  let inserted = 0
  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows.slice(i, i + 100)
    try {
      const { error } = await supabase.from("pack_listings_cache").upsert(chunk, { onConflict: "id" })
      if (error) console.log(`[allday-packs] insert error:`, error)
      else inserted += chunk.length
    } catch (err) {
      console.log(`[allday-packs] insert error:`, err)
    }
  }

  // rows_found = groups built from the catalog; rows_written = rows actually
  // upserted into pack_listings_cache. They differ when an upsert chunk errors,
  // which is exactly the silent partial-write this route could not report.
  await logPipelineRun({
    startedAtIso,
    ok: true,
    rowsFound: rows.length,
    rowsWritten: inserted,
    rowsSkipped: rows.length - inserted,
    extra: {
      phase: "complete",
      groups_found: groupsFound,
      groups_with_listings: groupsWithListings,
      editions_loaded: editionRows.length,
      listings_loaded: listingRows.length,
      delete_error: del.error?.message ?? null,
      elapsed_ms: Date.now() - started,
    },
  })
}

export async function GET() {
  const { data, error } = await supabase.rpc("get_pack_listings_by_collection", {
    p_collection_id: ALLDAY_COLLECTION_ID,
  })
  if (error) {
    console.warn(`[allday-pack-listings] rpc error: ${error.message}`)
  // ⚠ UNGATED GET sitting in a file whose POST *is* token-gated, so a
  // FILE-level auth grep vouches for this handler and should not. Raw
  // `error.message` here is the /api/sets leak, reachable by anyone — and this one serves PRODUCT
  // data, shipping `listings: []` packaged alongside the failure.
    return apiErrorResponse(error, "api/allday-pack-listings GET")
  }
  const rows: any[] = Array.isArray(data) ? data : []

  const listings = rows.map((r: any) => ({
    packListingId: r.id,
    distId: r.id,
    title: r.pack_name,
    tier: String(r.tier ?? "common").toLowerCase(),
    imageUrl: r.image_url ?? "",
    momentsPerPack: r.moments_per_pack ?? 1,
    retailPrice: normalizePackRetailPrice(r.retail_price_usd),
    lowestAsk: Number(r.lowest_ask_usd ?? 0),
    startTime: r.first_seen_at ?? r.cached_at ?? new Date().toISOString(),
    listingCount: Number(r.total_listed ?? 0),
    packType: "standard" as const,
    seriesLabel: null,
  }))

  return NextResponse.json({ listings })
}
