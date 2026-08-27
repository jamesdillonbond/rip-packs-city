import { NextRequest, NextResponse } from "next/server"
import { after } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

// ── NFL All Day listing cache ─────────────────────────────────────────────────
//
// Orchestrates the Flowty → cached_listings pipeline for NFL All Day by calling
// the Supabase flowty-proxy edge function (which sidesteps Flowty's IP filter),
// replaces the AD rows in cached_listings, and regenerates ASK_ONLY FMV
// snapshots via the fmv_from_cached_listings RPC.
// ─────────────────────────────────────────────────────────────────────────────

export const maxDuration = 300

const TOKEN = process.env.INGEST_SECRET_TOKEN ?? ""
const AD_COLLECTION_ID = "dee28451-5d62-409e-a1ad-a83f763ac070"
const AD_CONTRACT_ADDRESS = "0xe4cf4bdc1751c65d"
const AD_CONTRACT_NAME = "AllDay"
const FLOWTY_PROXY_URL =
  "https://bxcqstmqfzmuolpuynti.supabase.co/functions/v1/flowty-proxy"
const FLOWTY_PROXY_TOKEN = process.env.FLOWTY_PROXY_TOKEN
if (!FLOWTY_PROXY_TOKEN) {
  throw new Error("FLOWTY_PROXY_TOKEN env var is required")
}
// 2026-07-11: the marketplace-GQL leg (searchMarketplaceEditions via
// nflallday.com/consumer/graphql) was removed — it 403'd from Cloudflare WAF via
// BOTH the direct endpoint and the topshot-proxy worker /allday-consumer route,
// contributing 0 rows and only log noise every tick. AllDay asks are already
// covered by the on-chain listings indexer (cached_listings_v2, ~65% edition
// coverage, fresh) and AllDay badge low_ask by the residential Atlas badge
// ingest. The Flowty on-chain path below and the badge low_ask staleness
// cleanup are retained.
// Dual-sort sweep constants. We fetch up to 10 pages sorted salePrice asc
// (captures the cheap/floor listings) and 10 sorted salePrice desc (captures
// the expensive tail that price-asc pagination never reaches), at 50 listings
// per page. 10 × 50 × 2 = up to 1000 listings per run before dedup; in
// practice dedup collapses overlap to a few hundred unique listings. The
// previous PAGE_LIMIT=24 with only 3 offsets was capping runs at ~48
// listings, well below the actual AllDay marketplace depth.
//
// Each sweep breaks early as soon as a page returns < PAGE_LIMIT rows
// (signals end-of-data for that sort direction), so smaller marketplaces
// don't pay the full 20-page cost.
const PAGE_LIMIT = 50
const SWEEP_OFFSETS = [0, 50, 100, 150, 200, 250, 300, 350, 400, 450]
const INTER_PAGE_DELAY_MS = 200
const UPSERT_CHUNK = 50
const EDITION_LOOKUP_CHUNK = 100

type FlowtySort = { direction: "asc" | "desc"; path: "salePrice" }

type Trait = { name?: string; value?: unknown }

type Order = {
  state?: string
  listingResourceID?: string
  usdValue?: number | string | null
  valuations?: { blended?: { usdValue?: number | string | null } }
  storefrontAddress?: string | null
  providerAddress?: string | null
  blockTimestamp?: number | string | null
}

type NFT = {
  id?: string | number
  nftId?: string | number
  nftView?: {
    serial?: number | string
    traits?: { traits?: Trait[] }
    editions?: { infoList?: Array<{ max?: number | null }> }
  }
  card?: { images?: Array<{ url?: string }> }
  orders?: Order[]
}

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

function traitValue(traits: Trait[] | undefined, name: string): string | null {
  if (!traits) return null
  const hit = traits.find((t) => t?.name === name)
  if (!hit) return null
  const v = hit.value
  return v === null || v === undefined ? null : String(v)
}

function toNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null
  const n = typeof v === "number" ? v : parseFloat(String(v))
  return Number.isFinite(n) ? n : null
}

async function fetchPage(offset: number, sort: FlowtySort) {
  // 30s cap. `fetch()` has NO default timeout and this runs inside an `after()`
  // body under maxDuration 300, so one upstream holding the connection open
  // consumes the whole tick — and a maxDuration kill writes NO terminal
  // pipeline_runs row, leaving the outage invisible ("the cron never fired").
  // Same class that cost the candy board a 44h blackout (2026-08-27).
  //
  // ⚠ NO whole-loop deadline here, deliberately. Measured over 48h these caches
  // ran 142/142 ok — they are FINISHING, so a budget could only truncate healthy
  // runs. ⓘ Their maxes (topshot 361.5s, allday 344.3s) EXCEED the declared 300s
  // ceiling, the same Fluid Compute overrun seen on candy-listings — which is
  // precisely why a deadline must never be sized off the config value.
  const res = await fetch(FLOWTY_PROXY_URL, {
    signal: AbortSignal.timeout(30_000),
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${FLOWTY_PROXY_TOKEN}`,
    },
    body: JSON.stringify({
      contractAddress: AD_CONTRACT_ADDRESS,
      contractName: AD_CONTRACT_NAME,
      // Flowty's collection endpoint accepts sort inside the payload; the
      // flowty-proxy edge function forwards the payload unchanged.
      // listingKind:"sale" matches the Pinnacle pattern — every returned NFT
      // is guaranteed to have an active sale order, so PAGE_LIMIT rows
      // translate ~1:1 to listings instead of being filtered down by the
      // state==="LISTED" check below.
      payload: { filters: { listingKind: "sale" }, offset, limit: PAGE_LIMIT, sort },
    }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`flowty-proxy ${res.status}: ${text.slice(0, 200)}`)
  }
  return (await res.json()) as { nfts?: NFT[]; total?: number }
}

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? ""
  const bearer = auth.replace(/^Bearer\s+/i, "")
  const urlToken = req.nextUrl.searchParams.get("token") ?? ""
  if (!TOKEN || (bearer !== TOKEN && urlToken !== TOKEN)) return unauthorized()

  after(async () => {
    await runListingCache()
  })

  return NextResponse.json({
    status: "accepted",
    message: "allday-listing-cache started in background via after()",
    startedAt: new Date().toISOString(),
  })
}

const PIPELINE_NAME = "allday-listing-cache"
const COLLECTION_SLUG = "nfl_all_day"

async function runListingCache() {
  const startedAt = Date.now()
  const startedAtIso = new Date(startedAt).toISOString()
  const stats = {
    ok: true,
    errorMsg: null as string | null,
    totalFetched: 0,
    totalListed: 0,
    upserted: 0,
    upsertErrors: 0,
    editionsMapped: 0,
    fmvRpcCalled: false,
    badge_low_ask_stale_cleared: 0,
    // ⚠ COMPLETENESS, not a row count. The dual-sort sweep below `continue`s
    // past a failed page, so a Flowty error silently removes a whole 50-listing
    // window from the run — and the stale purge that follows deletes every row
    // this run did not re-write. Without this counter a partial book is
    // indistinguishable from a complete one and the purge turns a transient
    // upstream error into a DELETE of live listings.
    pageErrors: 0,
    sweepError: null as string | null,
  }

  try {

  type Row = {
    id: string
    flow_id: string
    moment_id: string | null
    player_name: string | null
    team_name: string | null
    set_name: string | null
    series_name: string | null
    tier: string | null
    serial_number: number | null
    circulation_count: number | null
    ask_price: number | null
    fmv: number | null
    source: string
    buy_url: string
    thumbnail_url: string | null
    listing_resource_id: string
    storefront_address: string | null
    is_locked: boolean
    listed_at: string | null
    cached_at: string
    collection_id: string
    edition_external_id: string | null
  }

  const rows: Row[] = []
  // Dedup by listing_resource_id (primary) — the same NFT can appear in both
  // sorts if it's mid-range, and using listing_resource_id is safer than
  // flow_id because the same flow_id could theoretically have two active
  // listings under rare conditions.
  const seenListingIds = new Set<string>()

  const sweeps: Array<{ label: string; sort: FlowtySort }> = [
    { label: "asc",  sort: { direction: "asc",  path: "salePrice" } },
    { label: "desc", sort: { direction: "desc", path: "salePrice" } },
  ]

  for (const sweep of sweeps) {
    for (const offset of SWEEP_OFFSETS) {
      const page = await fetchPage(offset, sweep.sort).catch((err) => {
        console.log(`[allday-listing-cache] Page sweep=${sweep.label} offset=${offset} failed: ${String(err)}`)
        return null
      })
      if (!page) {
        stats.pageErrors++
        stats.sweepError = `sweep=${sweep.label} offset=${offset} fetch failed`
        continue
      }
      const nfts = Array.isArray(page.nfts) ? page.nfts : []
      stats.totalFetched += nfts.length
      // Stop walking deeper into this sort direction once a page returns no
      // NFTs at all — the marketplace doesn't have any more listings under
      // this sort, and further offsets will also be empty.
      if (nfts.length === 0) break

      for (const nft of nfts) {
        const orders = Array.isArray(nft.orders) ? nft.orders : []
        const listedOrder = orders.find((o) => o?.state === "LISTED")
        if (!listedOrder) continue
        const listingResourceID = listedOrder.listingResourceID
        if (!listingResourceID) continue
        const listingKey = String(listingResourceID)
        if (seenListingIds.has(listingKey)) continue

        const nftIdRaw = nft.nftId ?? nft.id
        if (nftIdRaw === undefined || nftIdRaw === null) continue
        const nftIdStr = String(nftIdRaw)

        const traits = nft.nftView?.traits?.traits
        const editionId = traitValue(traits, "editionID")
        const serialNumber =
          toNumber(traitValue(traits, "serialNumber")) ??
          toNumber(nft.nftView?.serial)
        const editionTier = traitValue(traits, "editionTier")
        const setName = traitValue(traits, "setName")
        const seriesName = traitValue(traits, "seriesName")
        const teamName = traitValue(traits, "teamName")
        let playerName = traitValue(traits, "Player Name")
        if (!playerName) {
          const first = traitValue(traits, "playerFirstName")
          const last = traitValue(traits, "playerLastName")
          const joined = [first, last].filter(Boolean).join(" ").trim()
          playerName = joined || null
        }

        const circulation =
          toNumber(nft.nftView?.editions?.infoList?.[0]?.max) ?? null
        const thumbnail = nft.card?.images?.[0]?.url ?? null
        const askPrice = toNumber(listedOrder.usdValue)
        const rawFmv = toNumber(listedOrder.valuations?.blended?.usdValue)
        const fmv = rawFmv && rawFmv > 0 ? rawFmv : null
        const storefrontAddress =
          listedOrder.storefrontAddress ?? listedOrder.providerAddress ?? null
        const ts = listedOrder.blockTimestamp
        let listedAt: string | null = null
        if (ts !== null && ts !== undefined) {
          const ms = typeof ts === "number" ? ts : parseFloat(String(ts))
          if (Number.isFinite(ms)) listedAt = new Date(ms).toISOString()
        }
        const buyUrl = `https://www.flowty.io/asset/${AD_CONTRACT_ADDRESS}/${AD_CONTRACT_NAME}/NFT/${nftIdStr}?listingResourceID=${listingResourceID}`

        seenListingIds.add(listingKey)
        rows.push({
          id: listingKey,
          flow_id: nftIdStr,
          moment_id: editionId ?? null,
          player_name: playerName,
          team_name: teamName,
          set_name: setName,
          series_name: seriesName,
          tier: editionTier,
          serial_number: serialNumber,
          circulation_count: circulation,
          ask_price: askPrice,
          fmv,
          source: "flowty",
          buy_url: buyUrl,
          thumbnail_url: thumbnail,
          listing_resource_id: listingKey,
          storefront_address: storefrontAddress,
          is_locked: false,
          listed_at: listedAt,
          cached_at: new Date().toISOString(),
          collection_id: AD_COLLECTION_ID,
          edition_external_id: editionId,
        })
      }

      // Short page = end of data for this sort direction; stop paginating it.
      if (nfts.length < PAGE_LIMIT) break

      await delay(INTER_PAGE_DELAY_MS)
    }
  }

  stats.totalListed = rows.length

  // Dedup by flow_id before upsert. onConflict: 'flow_id' rejects the whole
  // batch when two VALUES rows share the conflict key, and the dual-sort
  // sweep can produce the same nftId under different listing_resource_ids.
  // Keep the row with the lower ask_price per flow_id.
  const byFlowId = new Map<string, Row>()
  for (const row of rows) {
    const prev = byFlowId.get(row.flow_id)
    if (!prev) {
      byFlowId.set(row.flow_id, row)
      continue
    }
    const prevAsk = prev.ask_price
    const nextAsk = row.ask_price
    if (nextAsk != null && (prevAsk == null || nextAsk < prevAsk)) {
      byFlowId.set(row.flow_id, row)
    }
  }
  const dedupedRows = Array.from(byFlowId.values())

  // Batch-lookup edition UUIDs (currently unused in writes; cached_listings has
  // no edition_id column, but we expose mapped count in the summary).
  const editionIds = Array.from(
    new Set(dedupedRows.map((r) => r.edition_external_id).filter((x): x is string => !!x))
  )
  const editionMap = new Map<string, string>()
  for (let i = 0; i < editionIds.length; i += EDITION_LOOKUP_CHUNK) {
    const chunk = editionIds.slice(i, i + EDITION_LOOKUP_CHUNK)
    const { data, error } = await supabaseAdmin
      .from("editions")
      .select("id, external_id")
      .eq("collection_id", AD_COLLECTION_ID)
      .in("external_id", chunk)
    if (error) {
      console.log(`[allday-listing-cache] edition lookup error: ${error.message}`)
      continue
    }
    for (const row of data ?? []) {
      if (row.external_id && row.id) editionMap.set(row.external_id, row.id)
    }
  }
  stats.editionsMapped = editionMap.size

  // Upsert first, then conditionally purge stale rows. Matches the Top Shot /
  // Golazos pattern — a failed Flowty sweep no longer wipes the entire cache
  // to 0 before the upsert runs.
  const runStartedAt = new Date(startedAt).toISOString()
  for (let i = 0; i < dedupedRows.length; i += UPSERT_CHUNK) {
    const batch = dedupedRows.slice(i, i + UPSERT_CHUNK).map((r) => {
      const { edition_external_id: _drop, ...rest } = r
      return rest
    })
    const { error, count } = await supabaseAdmin
      .from("cached_listings")
      .upsert(batch, { onConflict: "flow_id", count: "exact" })
    if (error) {
      console.log(
        `[allday-listing-cache] upsert batch ${i} failed: ${error.message}`
      )
      stats.upsertErrors += batch.length
    } else {
      stats.upserted += count ?? batch.length
    }
  }

  // Only purge stale AllDay rows if at least one new row was upserted AND
  // every page of the sweep came back, so neither a Flowty outage nor a
  // partial one wipes listings this run simply never saw.
  // ⚠ `upserted > 0` alone was NOT enough: one failed page out of twenty still
  // satisfies it while the run holds a book with a 50-listing hole in it, and
  // the purge then deletes exactly the listings that lived in that hole.
  if (stats.upserted > 0 && stats.pageErrors === 0) {
    const { error: delErr } = await supabaseAdmin
      .from("cached_listings")
      .delete()
      .eq("collection_id", AD_COLLECTION_ID)
      .eq("source", "flowty")
      .lt("cached_at", runStartedAt)
    if (delErr) {
      console.log(`[allday-listing-cache] stale purge error: ${delErr.message}`)
    }
  } else {
    // Name the ACTUAL reason. The old single message said "0 rows upserted" for
    // every skip, which would now misreport the partial-sweep case as an empty
    // one — the same conflation this change exists to remove.
    console.log(
      stats.pageErrors > 0
        ? `[allday-listing-cache] ${stats.pageErrors} page fetch error(s) — sweep is partial, preserving prior cache`
        : "[allday-listing-cache] 0 rows upserted — preserving prior cache"
    )
  }

  // Badge low_ask staleness cleanup: any badge_editions row in the AllDay
  // collection whose updated_at hasn't been touched in 100 minutes gets
  // low_ask = NULL. AllDay badge low_ask is written by the residential Atlas
  // badge ingest (a separate Task Scheduler job), not this route; this
  // unconditional cleanup ages out rows that stop being seen there. (The dead
  // marketplace-GQL leg that used to feed marketplace FMV + a GQL-sourced
  // low_ask update here was removed 2026-07-11 — WAF-403 from both the direct
  // endpoint and the worker; it contributed 0 rows.)
  try {
    const { data: staleData, error: staleErr } = await supabaseAdmin.rpc(
      "clear_badge_low_ask_stale",
      {
        p_collection_id: AD_COLLECTION_ID,
        p_stale_after: "100 minutes",
      }
    )
    if (staleErr) {
      console.log(
        `[allday-listing-cache] clear_badge_low_ask_stale error: ${staleErr.message}`
      )
    } else {
      stats.badge_low_ask_stale_cleared = Number(staleData ?? 0) || 0
      console.log(
        `[allday-listing-cache] badge_editions stale-cleared (>100min): ${stats.badge_low_ask_stale_cleared}`
      )
    }
  } catch (err) {
    console.log(
      `[allday-listing-cache] clear_badge_low_ask_stale threw (non-fatal): ${
        err instanceof Error ? err.message : String(err)
      }`
    )
  }

  // Regenerate ASK_ONLY FMV snapshots from cached listings, then refresh
  // sales-based FMV so editions with sales get SALES_ONLY / HIGH upgrades
  // alongside the listing-based ASK_ONLY rows created above.
  try {
    const { error } = await supabaseAdmin.rpc("fmv_from_cached_listings", {
      p_collection_id: AD_COLLECTION_ID,
    })
    if (error) {
      console.log(`[allday-listing-cache] fmv rpc error: ${error.message}`)
    } else {
      stats.fmvRpcCalled = true
    }
  } catch (err) {
    console.log(`[allday-listing-cache] fmv rpc threw: ${String(err)}`)
  }

  } catch (err) {
    stats.ok = false
    stats.errorMsg = err instanceof Error ? err.message : String(err)
    console.log(`[allday-listing-cache] fatal: ${stats.errorMsg}`)
  } finally {
    // A partial sweep is a DEGRADED run, not a clean one — the purge above is
    // skipped, so `cached_listings` silently drifts toward holding delisted
    // rows. Report it as a failure (the `ingest/candy-offers` `degradedSweep`
    // precedent) instead of hiding it behind a healthy-looking `upserted`.
    // A real fatal error keeps precedence over the degradation message.
    const degradedSweep = stats.pageErrors > 0
    const okFinal = stats.ok && !degradedSweep
    const errorFinal =
      stats.errorMsg ??
      (degradedSweep
        ? `sweep incomplete: ${stats.pageErrors} page fetch error(s), last ${stats.sweepError ?? "unknown"} — stale purge skipped, cache may hold delisted rows`
        : null)
    try {
      await (supabaseAdmin as any).rpc("log_pipeline_run", {
        p_pipeline: PIPELINE_NAME,
        p_started_at: startedAtIso,
        p_rows_found: stats.totalListed,
        p_rows_written: stats.upserted,
        p_rows_skipped: stats.upsertErrors,
        p_ok: okFinal,
        p_error: errorFinal,
        p_collection_slug: COLLECTION_SLUG,
        p_cursor_before: null,
        p_cursor_after: null,
        p_extra: {
          total_fetched: stats.totalFetched,
          editions_mapped: stats.editionsMapped,
          fmv_rpc_called: stats.fmvRpcCalled,
          badge_low_ask_stale_cleared: stats.badge_low_ask_stale_cleared,
          // The field an observer keys on, so the incidence of a partial sweep
          // is countable rather than only inferable from a log line.
          sweep_complete: !degradedSweep,
          page_errors: stats.pageErrors,
          duration_ms: Date.now() - startedAt,
        },
      })
    } catch (e) {
      console.log(
        `[allday-listing-cache] log_pipeline_run err: ${
          e instanceof Error ? e.message : String(e)
        }`
      )
    }
    console.log(
      `[allday-listing-cache] done: ${JSON.stringify({
        ...stats,
        durationMs: Date.now() - startedAt,
      })}`
    )
  }

  return { ...stats, durationMs: Date.now() - startedAt, startedAt: startedAtIso }
}

export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? ""
  const bearer = auth.replace(/^Bearer\s+/i, "")
  const urlToken = req.nextUrl.searchParams.get("token") ?? ""
  if (!TOKEN || (bearer !== TOKEN && urlToken !== TOKEN)) return unauthorized()

  const result = await runListingCache()
  return NextResponse.json(result)
}
