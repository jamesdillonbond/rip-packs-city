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
const FLOWTY_PROXY_TOKEN = "rippackscity2026"
const PAGE_LIMIT = 50
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
      payload: { filters: {}, offset, limit: PAGE_LIMIT },
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

  after(async () => {
    await runListingCache()
  })

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

  for (let page = 0; page < MAX_PAGES; page++) {
    const offset = page * PAGE_LIMIT
    console.log(
      "[topshot-listing-cache] request_params",
      JSON.stringify({
        contractAddress: TS_CONTRACT_ADDRESS,
        contractName: TS_CONTRACT_NAME,
        page,
        offset,
      })
    )
    const pageResp = await fetchPage(offset).catch((err) => {
      console.log(`[topshot-listing-cache] Page offset=${offset} failed: ${String(err)}`)
      return null
    })
    if (!pageResp) break
    const rawRows = pageResp.nfts
    console.log(
      "[topshot-listing-cache] fetch_result",
      JSON.stringify({
        status: pageResp.status,
        count: rawRows?.length ?? "undefined",
        sample: rawRows?.[0] ? JSON.stringify(rawRows[0]).slice(0, 500) : "EMPTY",
      })
    )
    if (pageResp.status >= 400) {
      console.log(
        `[topshot-listing-cache] non_ok_status status=${pageResp.status} errorText=${pageResp.errorText ?? ""}`
      )
      break
    }
    const nfts = Array.isArray(rawRows) ? rawRows : []
    stats.totalFetched += nfts.length
    const reportedTotal = typeof pageResp.total === "number" ? pageResp.total : null
    const prevSeenSize = seenFlowIds.size

    for (const nft of nfts) {
      const orders = Array.isArray(nft?.orders) ? nft.orders : []
      const listedOrder = orders.find((o: any) => o?.state === "LISTED")
      if (!listedOrder) continue
      const nftIdRaw = nft?.id ?? nft?.nftId
      if (nftIdRaw === undefined || nftIdRaw === null) continue
      const nftIdStr = String(nftIdRaw)
      if (seenFlowIds.has(nftIdStr)) continue
      const listingResourceID = listedOrder.listingResourceID
      if (!listingResourceID) continue

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

      if (!playerName) continue

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

    if (nfts.length < PAGE_LIMIT) break
    if (seenFlowIds.size === prevSeenSize) break
    if (reportedTotal !== null && offset + PAGE_LIMIT >= reportedTotal) break
    await delay(INTER_PAGE_DELAY_MS)
  }

  stats.totalListed = rows.length

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

  const runStartedAt = new Date().toISOString()

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

  // Only purge stale rows if at least one new row was successfully upserted,
  // so a failed Flowty fetch doesn't wipe the existing cache.
  if (stats.upserted > 0) {
    const { error: delErr } = await supabaseAdmin
      .from("cached_listings")
      .delete()
      .eq("source", "flowty")
      .eq("collection_id", TS_COLLECTION_ID)
      .lt("cached_at", runStartedAt)
    if (delErr) {
      console.log(`[topshot-listing-cache] stale purge error: ${delErr.message}`)
    }
  }

  try {
    const recalcUrl = `https://rip-packs-city.vercel.app/api/fmv-recalc`
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
