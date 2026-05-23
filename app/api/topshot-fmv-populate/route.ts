// app/api/topshot-fmv-populate/route.ts
//
// Top Shot marketplace FMV sweep. Cursor-paginates the Top Shot
// `searchMarketplaceEditions` GraphQL feed through the topshot-proxy worker,
// reads each MarketplaceEdition's lowAsk / averageSaleData / salesCount, and
// writes LOW / ASK_ONLY fmv_snapshots via the upsert_topshot_marketplace_fmv
// RPC. Closes the "primary data" gap behind the ~10.8k NO_DATA Top Shot
// editions — see docs/research/topshot-marketplace-feed-2026-05.md.
//
// GraphQL schema verified live against the API 2026-05-23. Introspection is
// disabled upstream, so the shape was mapped by probing the proxy directly:
//
//   searchMarketplaceEditions(input: SearchMarketplaceEditionsInput!)
//     input.filters      MarketplaceEditionsFilterInput!  -- {} is valid (no required fields)
//     input.sortBy       MarketplaceEditionsSortType  -- REQUIRED: without a stable sort the
//                        rightCursor never advances and the API re-returns page 1
//     input.searchInput  BaseSearchInput!  -- { pagination: { cursor, direction, limit } }
//   -> data            SearchMarketplaceEditionsSummary
//      -> searchSummary SearchSummary
//         -> pagination { rightCursor }
//         -> data       MarketplaceEditions   (union member of SearchSummary.data)
//            -> data    [ MarketplaceEdition ]
//
//   MarketplaceEdition fields used:
//     id                            "{setUUID}+{playUUID}+{n}"
//     play.flowID                   play_id_onchain, as a string ("2634")
//     lowAsk                        lowest live ask (number)
//     salesCount                    marketplace sales count
//     averageSaleData.averagePrice  average sale price (null when salesCount = 0)
//
//   NOTE: set.flowId on the marketplace node is unpopulated (always 0), so the
//   setUUID parsed from `id` is mapped to set_id_onchain via the `sets` table;
//   play_id_onchain comes straight from play.flowID. The RPC then joins
//   editions on (set_id_onchain, play_id_onchain).
//
// Auth:   Bearer INGEST_SECRET_TOKEN, or ?token=.
// Cursor: backfill_state row `topshot-fmv-sweep` holds the GQL rightCursor; an
//         empty cursor starts the sweep from the beginning, and the cursor
//         resets to empty when the feed is exhausted (continuous refresh).

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

export const maxDuration = 300
export const dynamic = "force-dynamic"

const COLLECTION_ID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
const COLLECTION_SLUG = "nba_top_shot"
const PIPELINE_NAME = "topshot-fmv-populate"
const SWEEP_ID = "topshot-fmv-sweep"

const TS_PROXY_URL_DEFAULT = "https://public-api.nbatopshot.com/graphql"
const PAGE_LIMIT = 100
// A stable sort is mandatory: without it the rightCursor does not advance and
// searchMarketplaceEditions re-returns page 1 indefinitely. UPDATED_AT_DESC is
// a verified member of the MarketplaceEditionsSortType enum.
const SORT_BY = "UPDATED_AT_DESC"
const PAGE_DELAY_MS = 250
const TIME_BUDGET_OVERHEAD_MS = 45_000
const PER_REQUEST_TIMEOUT_MS = 12_000
const RPC_CHUNK = 500
const MAX_PAGES = 400 // hard runaway guard (40k editions/run)

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const TOKEN = process.env.INGEST_SECRET_TOKEN ?? ""

// Schema-verified query. SearchSummary.data is a union, hence the
// `... on MarketplaceEditions` fragment; MarketplaceEditions.data is a plain
// list of MarketplaceEdition, so its fields are selected directly.
const SEARCH_QUERY = `
  query TopshotMarketplaceFmv($input: SearchMarketplaceEditionsInput!) {
    searchMarketplaceEditions(input: $input) {
      data {
        searchSummary {
          pagination { rightCursor }
          data {
            ... on MarketplaceEditions {
              data {
                id
                lowAsk
                salesCount
                play { flowID }
                averageSaleData { averagePrice }
              }
            }
          }
        }
      }
    }
  }
`

type RawNode = {
  id?: string | null
  lowAsk?: number | string | null
  salesCount?: number | string | null
  play?: { flowID?: number | string | null } | null
  averageSaleData?: { averagePrice?: number | string | null } | null
}

type FmvRow = {
  set_id_onchain: number
  play_id_onchain: number
  lowest_ask: number | null
  average_price: number | null
  total_sales: number
}

function tsProxyUrl(): string {
  return process.env.TS_PROXY_URL || TS_PROXY_URL_DEFAULT
}

function tsProxyHeaders(): Record<string, string> {
  const h: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "rip-packs-city/topshot-fmv-populate",
  }
  if (process.env.TS_PROXY_SECRET) h["X-Proxy-Secret"] = process.env.TS_PROXY_SECRET
  return h
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function toNum(v: unknown): number | null {
  if (v == null || v === "") return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

// MarketplaceEdition.id is "{setUUID}+{playUUID}+{n}". UUIDs never contain '+',
// so a plain split is safe. Returns the lowercased setUUID, or null.
function setUuidFromId(id: string | null | undefined): string | null {
  if (!id) return null
  const parts = id.split("+")
  if (parts.length < 2) return null
  const setUuid = parts[0].trim().toLowerCase()
  return UUID_RE.test(setUuid) ? setUuid : null
}

type PageResult = {
  nodes: RawNode[]
  rightCursor: string | null
  gqlError: string | null
}

async function fetchPage(cursor: string): Promise<PageResult> {
  const body = {
    query: SEARCH_QUERY,
    operationName: "TopshotMarketplaceFmv",
    variables: {
      input: {
        filters: {},
        sortBy: SORT_BY,
        searchInput: {
          pagination: { cursor, direction: "RIGHT", limit: PAGE_LIMIT },
        },
      },
    },
  }
  try {
    const res = await fetch(tsProxyUrl(), {
      method: "POST",
      headers: tsProxyHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(PER_REQUEST_TIMEOUT_MS),
    })
    if (!res.ok) {
      const txt = await res.text().catch(() => "")
      return { nodes: [], rightCursor: null, gqlError: `http ${res.status}: ${txt.slice(0, 300)}` }
    }
    const json = (await res.json()) as {
      data?: {
        searchMarketplaceEditions?: {
          data?: {
            searchSummary?: {
              pagination?: { rightCursor?: string | null } | null
              data?: { data?: RawNode[] | null } | null
            } | null
          } | null
        } | null
      }
      errors?: unknown[]
    }
    if (Array.isArray(json.errors) && json.errors.length > 0) {
      return { nodes: [], rightCursor: null, gqlError: JSON.stringify(json.errors).slice(0, 400) }
    }
    const summary = json.data?.searchMarketplaceEditions?.data?.searchSummary
    return {
      nodes: summary?.data?.data ?? [],
      rightCursor: summary?.pagination?.rightCursor ?? null,
      gqlError: null,
    }
  } catch (e) {
    return {
      nodes: [],
      rightCursor: null,
      gqlError: e instanceof Error ? e.message : String(e),
    }
  }
}

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
}

async function handle(req: NextRequest): Promise<NextResponse> {
  const auth = req.headers.get("authorization") ?? ""
  const bearer = auth.replace(/^Bearer\s+/i, "")
  const urlToken = req.nextUrl.searchParams.get("token") ?? ""
  if (!TOKEN || (bearer !== TOKEN && urlToken !== TOKEN)) return unauthorized()

  const startedAt = Date.now()
  const startedAtIso = new Date(startedAt).toISOString()
  const supabase: any = supabaseAdmin

  // ── setUUID -> set_id_onchain map ─────────────────────────────────────────
  // searchMarketplaceEditions does not expose a usable set id (set.flowId is
  // unpopulated), so the setUUID parsed from MarketplaceEdition.id is resolved
  // here. Top Shot has only a few hundred sets, so one read covers them all.
  const { data: setsRaw, error: setsErr } = await supabase
    .from("sets")
    .select("external_id, set_id_onchain")
    .eq("collection_id", COLLECTION_ID)
    .not("set_id_onchain", "is", null)
    .limit(5000)
  if (setsErr) {
    return NextResponse.json(
      { error: "sets read failed", detail: setsErr.message },
      { status: 500 }
    )
  }
  const setOnchainByUuid = new Map<string, number>()
  for (const s of (setsRaw as Array<{ external_id: string | null; set_id_onchain: number | null }>)) {
    const ext = (s.external_id ?? "").trim().toLowerCase()
    if (UUID_RE.test(ext) && s.set_id_onchain != null) {
      setOnchainByUuid.set(ext, s.set_id_onchain)
    }
  }

  // ── Resume cursor ─────────────────────────────────────────────────────────
  let cursor = ""
  try {
    const { data: state } = await supabase
      .from("backfill_state")
      .select("cursor")
      .eq("id", SWEEP_ID)
      .maybeSingle()
    cursor = (state?.cursor ?? "") || ""
  } catch {
    cursor = ""
  }
  const cursorBefore = cursor

  const timeBudgetMs = maxDuration * 1000 - TIME_BUDGET_OVERHEAD_MS

  let pagesFetched = 0
  let nodesFetched = 0
  let upserted = 0
  let skipped = 0
  let noEdition = 0
  let unresolvedSet = 0
  let rpcError: string | null = null
  let firstGqlError: string | null = null
  let sweepComplete = false
  let terminatedReason = "time_budget_exceeded"
  let pending: FmvRow[] = []
  const seenCursors = new Set<string>()

  // Drains `pending` through the RPC in RPC_CHUNK batches. Returns false on the
  // first RPC error (which is recorded in rpcError).
  async function flush(): Promise<boolean> {
    while (pending.length > 0) {
      const chunk = pending.slice(0, RPC_CHUNK)
      const { data, error } = await supabase.rpc("upsert_topshot_marketplace_fmv", {
        p_rows: chunk,
      })
      if (error) {
        rpcError = error.message
        console.log(`[topshot-fmv-populate] rpc error: ${error.message}`)
        return false
      }
      const row = Array.isArray(data) ? data[0] : data
      if (row && typeof row === "object") {
        upserted += Number((row as any).upserted ?? 0) || 0
        skipped += Number((row as any).skipped ?? 0) || 0
        noEdition += Number((row as any).no_edition ?? 0) || 0
      }
      pending = pending.slice(chunk.length)
    }
    return true
  }

  for (let page = 0; page < MAX_PAGES; page++) {
    if (Date.now() - startedAt > timeBudgetMs) {
      terminatedReason = "time_budget_exceeded"
      break
    }

    const { nodes, rightCursor, gqlError } = await fetchPage(cursor)
    if (gqlError) {
      if (!firstGqlError) firstGqlError = gqlError
      terminatedReason = "gql_error"
      break
    }
    pagesFetched++
    nodesFetched += nodes.length

    for (const n of nodes) {
      const setUuid = setUuidFromId(n.id)
      const setOnchain = setUuid ? setOnchainByUuid.get(setUuid) : undefined
      const playOnchain = toNum(n.play?.flowID)
      if (setOnchain == null || playOnchain == null) {
        unresolvedSet++
        continue
      }
      pending.push({
        set_id_onchain: setOnchain,
        play_id_onchain: Math.trunc(playOnchain),
        lowest_ask: toNum(n.lowAsk),
        average_price: toNum(n.averageSaleData?.averagePrice),
        total_sales: toNum(n.salesCount) ?? 0,
      })
    }

    // Flush eagerly so a mid-run timeout still commits progress.
    if (pending.length >= RPC_CHUNK) {
      if (!(await flush())) {
        terminatedReason = "rpc_error"
        break
      }
    }

    // End-of-feed detection: empty/absent cursor, an empty page, or a cursor
    // that has already been seen (upstream stall).
    if (!rightCursor || nodes.length === 0 || seenCursors.has(rightCursor)) {
      sweepComplete = true
      terminatedReason = "feed_exhausted"
      break
    }
    seenCursors.add(rightCursor)
    cursor = rightCursor

    // Persist the cursor each page so a timeout resumes cleanly next run.
    try {
      await supabase
        .from("backfill_state")
        .update({ cursor, status: "pending", last_run_at: new Date().toISOString() })
        .eq("id", SWEEP_ID)
    } catch {
      /* non-fatal — the end-of-run write below is the durable one */
    }

    await sleep(PAGE_DELAY_MS)
  }

  // Final flush of whatever is left (skipped if an RPC error already fired).
  if (rpcError === null) {
    await flush()
  }

  // Wrap the cursor back to the start of the feed when the sweep completed.
  const nextCursor = sweepComplete ? "" : cursor
  try {
    await supabase
      .from("backfill_state")
      .update({
        cursor: nextCursor,
        status: sweepComplete ? "complete" : "pending",
        last_run_at: new Date().toISOString(),
      })
      .eq("id", SWEEP_ID)
  } catch (e) {
    console.log(`[topshot-fmv-populate] cursor update failed: ${e instanceof Error ? e.message : e}`)
  }

  const durationMs = Date.now() - startedAt
  const ok = rpcError === null && firstGqlError === null

  try {
    await supabase.from("pipeline_runs").insert({
      pipeline: PIPELINE_NAME,
      collection_slug: COLLECTION_SLUG,
      started_at: startedAtIso,
      finished_at: new Date().toISOString(),
      rows_found: nodesFetched,
      rows_written: upserted,
      rows_skipped: skipped,
      ok,
      error: rpcError ?? firstGqlError,
      cursor_before: cursorBefore || null,
      cursor_after: nextCursor || null,
      extra: {
        pages_fetched: pagesFetched,
        nodes_fetched: nodesFetched,
        upserted,
        skipped,
        no_edition: noEdition,
        unresolved_set: unresolvedSet,
        sweep_complete: sweepComplete,
        terminated_reason: terminatedReason,
        gql_error: firstGqlError,
        sets_mapped: setOnchainByUuid.size,
        duration_ms: durationMs,
      },
    })
  } catch (e) {
    console.log(`[topshot-fmv-populate] pipeline_runs insert failed: ${e instanceof Error ? e.message : e}`)
  }

  return NextResponse.json({
    ok,
    pipeline: PIPELINE_NAME,
    pages_fetched: pagesFetched,
    nodes_fetched: nodesFetched,
    upserted,
    skipped,
    no_edition: noEdition,
    unresolved_set: unresolvedSet,
    sweep_complete: sweepComplete,
    terminated_reason: terminatedReason,
    gql_error: firstGqlError,
    rpc_error: rpcError,
    sets_mapped: setOnchainByUuid.size,
    duration_ms: durationMs,
  })
}

export async function GET(req: NextRequest) {
  return handle(req)
}

export async function POST(req: NextRequest) {
  return handle(req)
}
