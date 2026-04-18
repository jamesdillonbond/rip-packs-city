import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

// ── AllDay FMV cursor sweep ──────────────────────────────────────────────────
//
// Standalone cron route: no Flowty fetching. Paginates the AllDay marketplace
// GQL (searchMarketplaceEditions, LISTED_DATE_DESC) from the cursor stored in
// backfill_state.allday-fmv-sweep, fetches 5 pages (up to 500 editions) per
// run, and upserts the result through upsert_allday_marketplace_fmv. When the
// sweep runs off the end of the feed, the cursor resets to NULL so the next
// invocation starts over.
// ─────────────────────────────────────────────────────────────────────────────

export const maxDuration = 25
export const dynamic = "force-dynamic"

const TOKEN = process.env.INGEST_SECRET_TOKEN ?? ""
const AD_GQL_PROXY = process.env.AD_PROXY_URL ?? ""
const AD_GQL_SECRET = process.env.AD_PROXY_SECRET ?? ""
const AD_GQL_FALLBACK = "https://nflallday.com/consumer/graphql"

const SWEEP_ID = "allday-fmv-sweep"
const PIPELINE_NAME = "allday-fmv-populate"
const COLLECTION_SLUG = "nfl_all_day"
const PAGES_PER_RUN = 5
const PAGE_SIZE = 100
const PAGE_TIMEOUT_MS = 6000

const AD_GQL_QUERY = `query SearchMarketplaceEditions($first: Int!, $after: String, $sortBy: EditionSortBy) {
  searchMarketplaceEditions(input: { first: $first, after: $after, sortBy: $sortBy }) {
    pageInfo { endCursor hasNextPage }
    edges {
      node {
        editionFlowID
        lowestPrice
        averageSale
        totalListings
      }
    }
  }
}`

type MarketRow = {
  edition_flow_id: string
  lowest_price: string
  average_sale: string
  total_listings: number
}

type PageResult = {
  rows: MarketRow[]
  endCursor: string | null
  hasNextPage: boolean
}

async function fetchPage(cursor: string | null): Promise<PageResult> {
  const url = AD_GQL_PROXY || AD_GQL_FALLBACK
  const useProxy = !!AD_GQL_PROXY
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (useProxy && AD_GQL_SECRET) headers["X-Proxy-Secret"] = AD_GQL_SECRET

  console.log('[allday-fmv-populate] endpoint:', url.slice(0, 30))

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      query: AD_GQL_QUERY,
      variables: {
        first: PAGE_SIZE,
        after: cursor,
        sortBy: "LISTED_DATE_DESC",
      },
    }),
    signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
  })

  if (!res.ok) {
    const txt = await res.text().catch(() => "")
    console.error('[allday-fmv-populate] page HTTP', res.status, txt.slice(0, 200))
    throw new Error(`GQL http ${res.status}: ${txt.slice(0, 200)}`)
  }

  const rawText = await res.text()
  let body: any
  try {
    body = JSON.parse(rawText)
  } catch (e) {
    console.error('[allday-fmv-populate] JSON parse failed, raw:', rawText.slice(0, 500))
    throw e
  }
  const data = body?.data?.searchMarketplaceEditions
  if (!data) {
    const errs = body?.errors ? JSON.stringify(body.errors).slice(0, 200) : ""
    throw new Error(`GQL missing data ${errs}`)
  }

  const edges = Array.isArray(data.edges) ? data.edges : []
  const rows: MarketRow[] = []
  for (const edge of edges) {
    const node = edge?.node
    if (!node?.editionFlowID) continue
    const totalListingsRaw = node.totalListings
    const totalListings =
      typeof totalListingsRaw === "number"
        ? totalListingsRaw
        : parseInt(String(totalListingsRaw ?? 0), 10) || 0
    rows.push({
      edition_flow_id: String(node.editionFlowID),
      lowest_price: node.lowestPrice != null ? String(node.lowestPrice) : "",
      average_sale: node.averageSale != null ? String(node.averageSale) : "",
      total_listings: totalListings,
    })
  }

  const endCursor = data.pageInfo?.endCursor ?? null
  const hasNextPage = !!data.pageInfo?.hasNextPage

  return { rows, endCursor: endCursor ? String(endCursor) : null, hasNextPage }
}

export async function GET(req: NextRequest) {
  const urlToken = req.nextUrl.searchParams.get("token") ?? ""
  if (!TOKEN || urlToken !== TOKEN) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  console.log('[allday-fmv-populate] start, proxy=', (process.env.AD_PROXY_URL ?? '').slice(0, 30))

  const startedAt = new Date()
  const startedAtIso = startedAt.toISOString()

  const { data: stateRow, error: stateErr } = await supabaseAdmin
    .from("backfill_state")
    .select("cursor, total_ingested")
    .eq("id", SWEEP_ID)
    .single()

  if (stateErr) {
    console.log(`[allday-fmv-populate] backfill_state read error: ${stateErr.message}`)
    return NextResponse.json(
      { error: "backfill_state read failed", detail: stateErr.message },
      { status: 500 }
    )
  }

  const cursorBefore: string | null = stateRow?.cursor ?? null
  const totalIngestedBefore: number = stateRow?.total_ingested ?? 0

  let cursor: string | null = cursorBefore
  let hasNextPage = true
  const allRows: MarketRow[] = []

  for (let pageNum = 0; pageNum < PAGES_PER_RUN; pageNum++) {
    try {
      const page = await fetchPage(cursor)
      allRows.push(...page.rows)
      cursor = page.endCursor
      hasNextPage = page.hasNextPage
      if (!hasNextPage) break
      if (!cursor) {
        hasNextPage = false
        break
      }
    } catch (err) {
      console.error('[allday-fmv-populate] page FAILED:', err instanceof Error ? err.message : String(err))
      break
    }
  }

  let upserted = 0
  let skipped = 0
  let no_edition = 0

  if (allRows.length > 0) {
    const { data, error } = await supabaseAdmin.rpc(
      "upsert_allday_marketplace_fmv",
      { p_rows: JSON.stringify(allRows) as any }
    )
    if (error) {
      console.log(`[allday-fmv-populate] upsert rpc error: ${error.message}`)
    } else {
      const row = Array.isArray(data) ? data[0] : data
      if (row && typeof row === "object") {
        upserted = Number((row as any).upserted ?? 0) || 0
        skipped = Number((row as any).skipped ?? 0) || 0
        no_edition = Number((row as any).no_edition ?? 0) || 0
      }
    }
  }

  const sweepComplete = !hasNextPage
  const cursorAfter = sweepComplete ? null : cursor
  const nextStatus = sweepComplete ? "complete" : "running"

  const { error: updateErr } = await supabaseAdmin
    .from("backfill_state")
    .update({
      cursor: cursorAfter,
      status: nextStatus,
      last_run_at: new Date().toISOString(),
      total_ingested: totalIngestedBefore + upserted,
    })
    .eq("id", SWEEP_ID)

  if (updateErr) {
    console.log(`[allday-fmv-populate] backfill_state update error: ${updateErr.message}`)
  }

  try {
    await (supabaseAdmin as any).rpc("log_pipeline_run", {
      p_pipeline: PIPELINE_NAME,
      p_started_at: startedAtIso,
      p_rows_found: allRows.length,
      p_rows_written: upserted,
      p_rows_skipped: skipped,
      p_ok: true,
      p_error: null,
      p_collection_slug: COLLECTION_SLUG,
      p_cursor_before: cursorBefore,
      p_cursor_after: cursorAfter,
      p_extra: {
        editions_fetched: allRows.length,
        upserted,
        skipped,
        no_edition,
        cursor_before: cursorBefore,
        cursor_after: cursorAfter,
        sweep_complete: sweepComplete,
      },
    })
  } catch (e) {
    console.log(
      `[allday-fmv-populate] log_pipeline_run err: ${
        e instanceof Error ? e.message : String(e)
      }`
    )
  }

  return NextResponse.json({
    ok: true,
    editions_fetched: allRows.length,
    upserted,
    skipped,
    no_edition,
    cursor_after: cursorAfter,
    sweep_complete: sweepComplete,
  })
}
