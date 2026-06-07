import { NextRequest, NextResponse } from "next/server"
import { after } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

// ── NBA Top Shot listing cache ────────────────────────────────────────────────
//
// Dedicated TS listing refresh via the Supabase flowty-proxy edge function.
// Mirrors allday/ufc/golazos pattern: GET returns immediately (accepted) and
// Vercel `after()` runs the paginated fetch + upsert in the background with
// maxDuration=300 so we don't hit the serverless function timeout on large
// page counts like the shared /api/listing-cache route does.
// ─────────────────────────────────────────────────────────────────────────────

export const maxDuration = 300

const TOKEN = process.env.INGEST_SECRET_TOKEN ?? ""
const TS_COLLECTION_ID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
const TS_CONTRACT_ADDRESS = "0x0b2a3299cc857e29"
const TS_CONTRACT_NAME = "TopShot"
const FLOWTY_PROXY_URL =
  "https://bxcqstmqfzmuolpuynti.supabase.co/functions/v1/flowty-proxy"
const FLOWTY_PROXY_TOKEN = process.env.FLOWTY_PROXY_TOKEN
if (!FLOWTY_PROXY_TOKEN) {
  throw new Error("FLOWTY_PROXY_TOKEN env var is required")
}
// Match the Pinnacle pattern: page size 100 + listingKind:sale filter so each
// Flowty page returns 100 actively-listed NFTs (not 100 raw NFTs that we then
// have to filter for state==='LISTED' client-side, which is what was capping
// the previous PAGE_LIMIT=50 runs at ~56 listings/run).
const PAGE_LIMIT = 100
const MAX_PAGES = 20
const INTER_PAGE_DELAY_MS = 200
const UPSERT_CHUNK = 50

const SERIES_NAMES: Record<number, string> = {
  0: "Series 1",
  2: "Series 2",
  3: "Summer 2021",
  4: "Series 3",
  5: "Series 4",
  6: "Series 2023-24",
  7: "Series 2024-25",
  8: "Series 2025-26",
}

type Trait = { name?: string; trait_type?: string; value?: unknown }

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

function traitValue(traits: Trait[] | undefined, ...names: string[]): string | null {
  if (!traits) return null
  for (const name of names) {
    const hit = traits.find((t) => t?.name === name || t?.trait_type === name)
    if (hit && hit.value !== null && hit.value !== undefined) {
      const s = String(hit.value).trim()
      if (s) return s
    }
  }
  return null
}

function toNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null
  const n = typeof v === "number" ? v : parseFloat(String(v))
  return Number.isFinite(n) ? n : null
}

async function fetchPage(
  offset: number
): Promise<{ status: number; nfts?: any[]; total?: number; errorText?: string }> {
  const res = await fetch(FLOWTY_PROXY_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${FLOWTY_PROXY_TOKEN}`,
    },
    body: JSON.stringify({
      contractAddress: TS_CONTRACT_ADDRESS,
      contractName: TS_CONTRACT_NAME,
      // listingKind: "sale" forces Flowty to return only NFTs with active sale
      // listings; without it, the proxy was returning a mix of listed/unlisted
      // NFTs and the loop hit the "no new flow_ids" early-break after 1-2 pages.
      payload: { filters: { listingKind: "sale" }, offset, limit: PAGE_LIMIT },
    }),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    return { status: res.status, errorText: text.slice(0, 200) }
  }
  const body = (await res.json()) as { nfts?: any[]; total?: number }
  return { status: res.status, nfts: body?.nfts, total: body?.total }
}

export async function GET(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? ""
  const bearer = auth.replace(/^Bearer\s+/i, "")
  const urlToken = req.nextUrl.searchParams.get("token") ?? ""
  if (!TOKEN || (bearer !== TOKEN && urlToken !== TOKEN)) return unauthorized()

  after(() => runListingCache())

  return NextResponse.json({
    status: "accepted",
    message: "topshot-listing-cache started in background via after()",
    startedAt: new Date().toISOString(),
  })
}

const PIPELINE_NAME = "topshot-listing-cache"
const COLLECTION_SLUG = "nba_top_shot"

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
    fmvRecalcCalled: false,
    // Stage counters — hoisted out of the inner try so the finally-scoped
    // log_pipeline_run call can fold them into pipeline_runs.extra.
    pagesFetched: 0,
    skipNoListedOrder: 0,
    skipMissingId: 0,
    skipMissingResourceID: 0,
    skipMissingPlayerName: 0,
    skipDuplicateInRun: 0,
    dedupedRows: 0,
    purgedRows: 0,
    purgeSkipped: false,
    headCountAfterPurge: null as number | null,
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
  }

  const rows: Row[] = []
  const seenFlowIds = new Set<string>()
  // Tolerate a single page where every flow_id was already seen (can happen if
  // Flowty briefly returns overlapping windows); only abort after two such
  // pages in a row. Bare empty pages still break immediately.
  let consecutiveStaleSeenPages = 0

  for (let page = 0; page < MAX_PAGES; page++) {
    const offset = page * PAGE_LIMIT
    const pageResp = await fetchPage(offset).catch((err) => {
      console.log(`[topshot-listing-cache] Page offset=${offset} failed: ${String(err)}`)
      return null
    })
    if (!pageResp) break
    const rawRows = pageResp.nfts
    if (pageResp.status >= 400) {
      console.log(
        `[topshot-listing-cache] non_ok_status status=${pageResp.status} errorText=${pageResp.errorText ?? ""}`
      )
      break
    }
    const nfts = Array.isArray(rawRows) ? rawRows : []
    stats.totalFetched += nfts.length
    stats.pagesFetched++
    console.log(
      `[topshot-listing-cache] stage=fetched page=${page} offset=${offset} fetched=${nfts.length} reportedTotal=${
        typeof pageResp.total === "number" ? pageResp.total : "null"
      }`
    )
    if (nfts.length === 0) break
    const reportedTotal = typeof pageResp.total === "number" ? pageResp.total : null
    const prevSeenSize = seenFlowIds.size
    const beforeRowsCount = rows.length

    for (const nft of nfts) {
      const orders = Array.isArray(nft?.orders) ? nft.orders : []
      const listedOrder = orders.find((o: any) => o?.state === "LISTED")
      if (!listedOrder) {
        stats.skipNoListedOrder++
        continue
      }
      const nftIdRaw = nft?.id ?? nft?.nftId
      if (nftIdRaw === undefined || nftIdRaw === null) {
        stats.skipMissingId++
        continue
      }
      const nftIdStr = String(nftIdRaw)
      if (seenFlowIds.has(nftIdStr)) {
        stats.skipDuplicateInRun++
        continue
      }
      const listingResourceID = listedOrder.listingResourceID
      if (!listingResourceID) {
        stats.skipMissingResourceID++
        continue
      }

      let traits: Trait[] = []
      const rawTraits = nft?.nftView?.traits
      if (Array.isArray(rawTraits)) traits = rawTraits
      else if (rawTraits && Array.isArray(rawTraits.traits)) traits = rawTraits.traits

      const seriesStr = traitValue(traits, "SeriesNumber", "seriesNumber", "Series Number")
      const seriesNum = seriesStr !== null ? parseInt(seriesStr, 10) : null
      const tierRaw = traitValue(traits, "Tier", "Moment Tier", "tier") ?? "COMMON"
      const teamName = traitValue(traits, "TeamAtMoment", "Team", "teamAtMoment", "teamName")
      const setName = traitValue(traits, "SetName", "Set Name", "setName")
      const playerName =
        (nft?.card?.title ? String(nft.card.title).trim() : null) ||
        traitValue(
          traits,
          "PlayerKnownName",
          "PlayerJerseyName",
          "Full Name",
          "Player Name",
          "playerName"
        )

      if (!playerName) {
        stats.skipMissingPlayerName++
        continue
      }

      const serial =
        toNumber(nft?.card?.num) ??
        toNumber(traitValue(traits, "serialNumber", "SerialNumber"))
      const circulation =
        toNumber(nft?.card?.max) ??
        toNumber(traitValue(traits, "numMoments", "maxEditionSize"))

      const thumbnail = nft?.card?.images?.[0]?.url ?? null
      const askPrice = toNumber(listedOrder.salePrice) ?? toNumber(listedOrder.usdValue)
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

      const seriesName =
        seriesNum !== null && !isNaN(seriesNum)
          ? SERIES_NAMES[seriesNum] ?? `Series ${seriesNum}`
          : seriesStr

      const momentId = nft?.nftView?.uuid ? String(nft.nftView.uuid) : null

      const buyUrl = `https://www.flowty.io/asset/${TS_CONTRACT_ADDRESS}/${TS_CONTRACT_NAME}/NFT/${nftIdStr}?listingResourceID=${listingResourceID}`

      seenFlowIds.add(nftIdStr)
      rows.push({
        id: String(listingResourceID),
        flow_id: nftIdStr,
        moment_id: momentId,
        player_name: playerName,
        team_name: teamName,
        set_name: setName,
        series_name: seriesName,
        tier: tierRaw.toUpperCase(),
        serial_number: serial,
        circulation_count: circulation,
        ask_price: askPrice,
        fmv,
        source: "flowty",
        buy_url: buyUrl,
        thumbnail_url: thumbnail,
        listing_resource_id: String(listingResourceID),
        storefront_address: storefrontAddress,
        is_locked: false,
        listed_at: listedAt,
        cached_at: new Date().toISOString(),
        collection_id: TS_COLLECTION_ID,
      })
    }

    const pageRowsAdded = rows.length - beforeRowsCount
    console.log(
      `[topshot-listing-cache] stage=parsed page=${page} pageRowsAdded=${pageRowsAdded} runRowsTotal=${rows.length} seenFlowIds=${seenFlowIds.size}`
    )
    if (nfts.length < PAGE_LIMIT) break
    if (seenFlowIds.size === prevSeenSize) {
      consecutiveStaleSeenPages++
      if (consecutiveStaleSeenPages >= 2) break
    } else {
      consecutiveStaleSeenPages = 0
    }
    if (reportedTotal !== null && offset + PAGE_LIMIT >= reportedTotal) break
    await delay(INTER_PAGE_DELAY_MS)
  }

  stats.totalListed = rows.length
  console.log(
    `[topshot-listing-cache] stage=parse-summary pagesFetched=${stats.pagesFetched} totalFetched=${stats.totalFetched} parsed=${rows.length} skipNoListedOrder=${stats.skipNoListedOrder} skipMissingId=${stats.skipMissingId} skipMissingResourceID=${stats.skipMissingResourceID} skipMissingPlayerName=${stats.skipMissingPlayerName} skipDuplicateInRun=${stats.skipDuplicateInRun}`
  )

  // Dedup by flow_id before upsert. onConflict: 'flow_id' rejects the whole
  // batch when two VALUES rows share the conflict key, and the Flowty sweep
  // can surface the same nftId under different listing_resource_ids across
  // sorted pages. Keep the row with the lower ask_price per flow_id.
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
  stats.dedupedRows = dedupedRows.length
  console.log(
    `[topshot-listing-cache] stage=deduped parsedRows=${rows.length} dedupedRows=${dedupedRows.length} flowIdCollisions=${rows.length - dedupedRows.length}`
  )

  const runStartedAt = new Date(startedAt).toISOString()

  for (let i = 0; i < dedupedRows.length; i += UPSERT_CHUNK) {
    const batch = dedupedRows.slice(i, i + UPSERT_CHUNK)
    const { error, count } = await supabaseAdmin
      .from("cached_listings")
      .upsert(batch, { onConflict: "flow_id", count: "exact" })
    if (error) {
      console.log(`[topshot-listing-cache] upsert batch ${i} failed: ${error.message}`)
      stats.upsertErrors += batch.length
    } else {
      stats.upserted += count ?? batch.length
    }
  }
  console.log(
    `[topshot-listing-cache] stage=written upserted=${stats.upserted} upsertErrors=${stats.upsertErrors}`
  )

  // Only purge stale rows if at least one new row was successfully upserted,
  // so a failed Flowty fetch doesn't wipe the existing cache.
  if (stats.upserted > 0) {
    const { error: delErr, count: delCount } = await supabaseAdmin
      .from("cached_listings")
      .delete({ count: "exact" })
      .eq("source", "flowty")
      .eq("collection_id", TS_COLLECTION_ID)
      .lt("cached_at", runStartedAt)
    if (delErr) {
      console.log(`[topshot-listing-cache] stale purge error: ${delErr.message}`)
    } else {
      stats.purgedRows = delCount ?? 0
    }
  } else {
    stats.purgeSkipped = true
  }
  const { count: postPurgeCount } = await supabaseAdmin
    .from("cached_listings")
    .select("*", { count: "exact", head: true })
    .eq("source", "flowty")
    .eq("collection_id", TS_COLLECTION_ID)
  stats.headCountAfterPurge = postPurgeCount ?? null
  console.log(
    `[topshot-listing-cache] stage=purged purgedRows=${stats.purgedRows} purgeSkipped=${stats.purgeSkipped} postPurgeRows=${postPurgeCount ?? "?"} runStartedAt=${runStartedAt}`
  )

  try {
    const recalcUrl = `${process.env.NEXT_PUBLIC_SITE_URL || "https://www.rippackscity.com"}/api/fmv-recalc`
    const res = await fetch(recalcUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${TOKEN}` },
    })
    stats.fmvRecalcCalled = res.ok
    if (!res.ok) {
      console.log(`[topshot-listing-cache] fmv-recalc HTTP ${res.status}`)
    }
  } catch (err) {
    console.log(`[topshot-listing-cache] fmv-recalc threw: ${String(err)}`)
  }

  // Wallet-verification fallback: any unresolved listing-amount challenge
  // whose challenge_amount now appears in cached_listings for the claimed
  // wallet gets flipped to verified by this RPC. Cheap, idempotent.
  //
  // NOTE (2026-06-07): this matcher is effectively a no-op — cached_listings is
  // frozen (Flowty shut 2026-05-13) so it can never find a new match. The live
  // verification path is the on-demand /api/profile/verify-challenge/check
  // route (direct topshot-proxy GQL). Left as a harmless idempotent pass;
  // safe to delete with the rest of the frozen-Flowty teardown.
  try {
    const { data: resolved, error: resolveErr } = await supabaseAdmin.rpc(
      "resolve_wallet_verification_challenges"
    )
    if (resolveErr) {
      console.log(`[topshot-listing-cache] verify resolver: ${resolveErr.message}`)
    } else {
      const count = Array.isArray(resolved) ? resolved.length : 0
      if (count > 0) console.log(`[topshot-listing-cache] resolved ${count} wallet challenges`)
    }
  } catch (err) {
    console.log(`[topshot-listing-cache] verify resolver threw: ${String(err)}`)
  }

  } catch (err) {
    stats.ok = false
    stats.errorMsg = err instanceof Error ? err.message : String(err)
    console.log(`[topshot-listing-cache] fatal: ${stats.errorMsg}`)
  } finally {
    try {
      await (supabaseAdmin as any).rpc("log_pipeline_run", {
        p_pipeline: PIPELINE_NAME,
        p_started_at: startedAtIso,
        p_rows_found: stats.totalListed,
        p_rows_written: stats.upserted,
        p_rows_skipped: stats.upsertErrors,
        p_ok: stats.ok,
        p_error: stats.errorMsg,
        p_collection_slug: COLLECTION_SLUG,
        p_cursor_before: null,
        p_cursor_after: null,
        p_extra: {
          total_fetched: stats.totalFetched,
          fmv_recalc_called: stats.fmvRecalcCalled,
          duration_ms: Date.now() - startedAt,
          fetched: stats.totalFetched,
          parsed: stats.totalListed,
          deduped: stats.dedupedRows,
          written: stats.upserted,
          purged: stats.purgedRows,
          purge_skipped: stats.purgeSkipped,
          head_count_after_purge: stats.headCountAfterPurge,
          pages_fetched: stats.pagesFetched,
          skip_no_listed_order: stats.skipNoListedOrder,
          skip_missing_id: stats.skipMissingId,
          skip_missing_resource_id: stats.skipMissingResourceID,
          skip_missing_player_name: stats.skipMissingPlayerName,
          skip_duplicate_in_run: stats.skipDuplicateInRun,
        },
      })
    } catch (e) {
      console.log(
        `[topshot-listing-cache] log_pipeline_run err: ${
          e instanceof Error ? e.message : String(e)
        }`
      )
    }
    console.log(
      `[topshot-listing-cache] done: ${JSON.stringify({
        ...stats,
        durationMs: Date.now() - startedAt,
      })}`
    )
  }
}
