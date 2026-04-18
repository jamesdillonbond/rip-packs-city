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
const CONCURRENCY_LOCK_MS = 3 * 60 * 1000

const AD_GQL_QUERY = `query SearchMarketplaceEditions($first: Int!, $after: String, $sortBy: MarketplaceEditionSortType) {
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

type RawNode = {
  editionFlowID?: string | null
  lowestPrice?: string | number | null
  averageSale?: string | number | null
  totalListings?: string | number | null
}

type PageResult = {
  nodes: RawNode[]
  endCursor: string | null
  hasNextPage: boolean
  nodeSample: any
}

async function fetchPage(cursor: string | null): Promise<PageResult> {
  const url = AD_GQL_PROXY || AD_GQL_FALLBACK
  const useProxy = !!AD_GQL_PROXY
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (useProxy && AD_GQL_SECRET) headers["X-Proxy-Secret"] = AD_GQL_SECRET

  console.log('[allday-fmv-populate] endpoint:', url.slice(0, 30))

  const variables = {
    first: PAGE_SIZE,
    after: cursor,
    sortBy: "LISTED_DATE_DESC",
  }
  const body: { query: string; variables: typeof variables; operationName?: string } = {
    query: AD_GQL_QUERY,
    variables,
  }

  console.log('[allday-fmv-populate] sending query for op:', body.operationName ?? 'none', 'vars:', JSON.stringify(variables ?? {}).slice(0, 100))

  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
  })

  if (!res.ok) {
    const txt = await res.text().catch(() => "")
    console.error('[allday-fmv-populate] page HTTP', res.status, txt.slice(0, 200))
    throw new Error(`GQL http ${res.status}: ${txt.slice(0, 200)}`)
  }

  const rawText = await res.text()
  let json: any
  try {
    json = JSON.parse(rawText)
  } catch (e) {
    console.error('[allday-fmv-populate] JSON parse failed, raw:', rawText.slice(0, 500))
    throw e
  }
  console.log('[allday-fmv-populate] page1-raw:', JSON.stringify(json).slice(0, 400))
  const data = json?.data?.searchMarketplaceEditions
  if (!data) {
    const errs = json?.errors ? JSON.stringify(json.errors).slice(0, 200) : ""
    throw new Error(`GQL missing data ${errs}`)
  }

  const edges = Array.isArray(data.edges) ? data.edges : []
  console.log('[allday-fmv-populate] raw edges:', edges.length, 'sample edge keys:', Object.keys(edges[0] ?? {}))
  const nodes: RawNode[] = edges.map((edge: any) => edge?.node)

  const endCursor = data.pageInfo?.endCursor ?? null
  const hasNextPage = !!data.pageInfo?.hasNextPage
  const nodeSample = edges[0]?.node ?? null

  return { nodes, endCursor: endCursor ? String(endCursor) : null, hasNextPage, nodeSample }
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
    .select("cursor, total_ingested, status, last_run_at")
    .eq("id", SWEEP_ID)
    .single()

  if (stateErr) {
    console.log(`[allday-fmv-populate] backfill_state read error: ${stateErr.message}`)
    return NextResponse.json(
      { error: "backfill_state read failed", detail: stateErr.message },
      { status: 500 }
    )
  }

  const statusBefore: string | null = (stateRow as any)?.status ?? null
  const lastRunAtRaw: string | null = (stateRow as any)?.last_run_at ?? null
  const lastRunMs = lastRunAtRaw ? new Date(lastRunAtRaw).getTime() : 0
  const lockAgeMs = lastRunMs > 0 ? startedAt.getTime() - lastRunMs : Number.POSITIVE_INFINITY
  if (statusBefore === "running" && lockAgeMs < CONCURRENCY_LOCK_MS) {
    console.log(`[allday-fmv-populate] concurrency guard: lock_age_ms=${lockAgeMs}`)
    return NextResponse.json({
      ok: false,
      reason: "concurrency_guard",
      lock_age_ms: lockAgeMs,
    })
  }

  const cursorBefore: string | null = stateRow?.cursor ?? null
  const totalIngestedBefore: number = stateRow?.total_ingested ?? 0

  const { error: lockErr } = await supabaseAdmin
    .from("backfill_state")
    .update({ status: "running", last_run_at: startedAtIso })
    .eq("id", SWEEP_ID)
  if (lockErr) {
    console.log(`[allday-fmv-populate] lock update err: ${lockErr.message}`)
  }

  let cursor: string | null = cursorBefore
  let hasNextPage = true
  const nodes: RawNode[] = []
  let lastError: string | null = null
  let nodeSample: any = null

  for (let pageNum = 0; pageNum < PAGES_PER_RUN; pageNum++) {
    try {
      const page = await fetchPage(cursor)
      if (nodeSample === null && page.nodeSample) nodeSample = page.nodeSample
      nodes.push(...page.nodes)
      cursor = page.endCursor
      hasNextPage = page.hasNextPage
      if (!hasNextPage) break
      if (!cursor) {
        hasNextPage = false
        break
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
      console.error('[allday-fmv-populate] page FAILED:', lastError)
      break
    }
  }

  let upserted = 0
  let skipped = 0
  let no_edition = 0
  let rpcError: string | null = null

  console.log('[allday-fmv-populate] batch size:', nodes.length, 'sample:', JSON.stringify(nodes[0] ?? null))

  if (nodes.length > 0) {
    const { data, error } = await supabaseAdmin.rpc(
      "upsert_allday_marketplace_fmv",
      { p_rows: nodes as any }
    )
    if (error) {
      rpcError = error.message
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
  const nextStatus = sweepComplete ? "complete" : "pending"

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
      p_rows_found: nodes.length,
      p_rows_written: upserted,
      p_rows_skipped: skipped,
      p_ok: true,
      p_error: null,
      p_collection_slug: COLLECTION_SLUG,
      p_cursor_before: cursorBefore,
      p_cursor_after: cursorAfter,
      p_extra: {
        editions_fetched: nodes.length,
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
    editions_fetched: nodes.length,
    upserted,
    skipped,
    no_edition,
    cursor_after: cursorAfter,
    sweep_complete: sweepComplete,
    debug_last_error: lastError ?? null,
    debug_batch_size: nodes.length,
    debug_node_sample: JSON.stringify(nodeSample ?? null),
    debug_rpc_error: rpcError ?? null,
  })
}
