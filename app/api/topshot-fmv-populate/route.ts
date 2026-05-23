// app/api/topshot-fmv-populate/route.ts
//
// Top Shot marketplace FMV sweep — the allday-fmv-populate equivalent for
// Top Shot. Walks the Top Shot catalog one set at a time via the Top Shot
// GraphQL `searchEditions` query (through the topshot-proxy worker), reads each
// edition's marketplace stats, and writes LOW / ASK_ONLY fmv_snapshots through
// the upsert_topshot_marketplace_fmv RPC. Closes the "primary data" gap that
// leaves ~10.8k Top Shot editions NO_DATA — see
// docs/research/topshot-marketplace-feed-2026-05.md.
//
// Auth: Bearer INGEST_SECRET_TOKEN, or ?token=.
// Cursor: backfill_state row `topshot-fmv-sweep` (cursor = last set id walked;
//         NULL wraps the sweep back to the start).
// The proxy/GQL/pagination shape is copied from the proven
// /api/admin/backfill-topshot-catalog route. The one schema bet is the
// `stats { lowestAsk averagePrice totalSales }` selection on the Edition node;
// any GraphQL error there is surfaced verbatim in pipeline_runs.extra.gql_error
// so the first run self-diagnoses.

import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

export const maxDuration = 300
export const dynamic = "force-dynamic"

const COLLECTION_ID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
const COLLECTION_SLUG = "nba-top-shot"
const PIPELINE_NAME = "topshot-fmv-populate"
const SWEEP_ID = "topshot-fmv-sweep"

const TS_PROXY_URL_DEFAULT = "https://public-api.nbatopshot.com/graphql"
const PAGE_LIMIT = 100
const SET_DELAY_MS = 250
const TIME_BUDGET_OVERHEAD_MS = 45_000
const PER_REQUEST_TIMEOUT_MS = 12_000
const RPC_CHUNK = 500

// Only UUID-format set external_ids are valid bySetIDs arguments to the GQL.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const TOKEN = process.env.INGEST_SECRET_TOKEN ?? ""

// Proven query shape from backfill-topshot-catalog (the searchSummary / Editions
// / Edition fragment wrappers are required by the schema), narrowed to the
// fields this feed needs plus the marketplace `stats` block.
const SEARCH_EDITIONS_QUERY = `
  query SearchEditionFmv($input: SearchEditionsInput!) {
    searchEditions(input: $input) {
      searchSummary {
        pagination { rightCursor }
        data {
          ... on Editions {
            data {
              ... on Edition {
                set { flowId }
                play { flowID }
                stats { lowestAsk averagePrice totalSales }
              }
            }
          }
        }
      }
    }
  }
`

type RawEdition = {
  set?: { flowId?: number | string | null } | null
  play?: { flowID?: number | string | null } | null
  stats?: {
    lowestAsk?: number | string | null
    averagePrice?: number | string | null
    totalSales?: number | string | null
  } | null
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

async function fetchEditionsPage(
  setUuid: string,
  cursor: string
): Promise<{ editions: RawEdition[]; nextCursor: string | null; gqlError: string | null }> {
  const body = {
    query: SEARCH_EDITIONS_QUERY,
    operationName: "SearchEditionFmv",
    variables: {
      input: {
        filters: { bySetIDs: [setUuid] },
        searchInput: { pagination: { cursor, direction: "RIGHT", limit: PAGE_LIMIT } },
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
      return { editions: [], nextCursor: null, gqlError: `http ${res.status}` }
    }
    const json = (await res.json()) as {
      data?: {
        searchEditions?: {
          searchSummary?: {
            pagination?: { rightCursor?: string | null }
            data?: { data?: RawEdition[] } | null
          } | null
        } | null
      }
      errors?: unknown[]
    }
    if (Array.isArray(json.errors) && json.errors.length > 0) {
      return { editions: [], nextCursor: null, gqlError: JSON.stringify(json.errors).slice(0, 400) }
    }
    const summary = json.data?.searchEditions?.searchSummary
    return {
      editions: summary?.data?.data ?? [],
      nextCursor: summary?.pagination?.rightCursor ?? null,
      gqlError: null,
    }
  } catch (e) {
    return {
      editions: [],
      nextCursor: null,
      gqlError: e instanceof Error ? e.message : String(e),
    }
  }
}

async function walkSet(
  setUuid: string
): Promise<{ editions: RawEdition[]; gqlError: string | null }> {
  const collected: RawEdition[] = []
  const seen = new Set<string>()
  let cursor = ""
  let gqlError: string | null = null
  // 50-page cap = 5000 editions/set — a runaway-loop guard; no real set is that big.
  for (let page = 0; page < 50; page++) {
    if (cursor && seen.has(cursor)) break
    if (cursor) seen.add(cursor)
    const result = await fetchEditionsPage(setUuid, cursor)
    if (result.gqlError && !gqlError) gqlError = result.gqlError
    if (result.editions.length === 0 && result.gqlError) break
    collected.push(...result.editions)
    if (!result.nextCursor || result.nextCursor === cursor) break
    cursor = result.nextCursor
  }
  return { editions: collected, gqlError }
}

function mapEdition(e: RawEdition): FmvRow | null {
  const setId = toNum(e.set?.flowId)
  const playId = toNum(e.play?.flowID)
  if (setId == null || playId == null) return null
  return {
    set_id_onchain: Math.trunc(setId),
    play_id_onchain: Math.trunc(playId),
    lowest_ask: toNum(e.stats?.lowestAsk),
    average_price: toNum(e.stats?.averagePrice),
    total_sales: toNum(e.stats?.totalSales) ?? 0,
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

  // ── Resume from the set-list cursor ───────────────────────────────────────
  let cursorSetId: string | null = null
  try {
    const { data: state } = await supabase
      .from("backfill_state")
      .select("cursor")
      .eq("id", SWEEP_ID)
      .maybeSingle()
    cursorSetId = state?.cursor ?? null
  } catch {
    cursorSetId = null
  }

  // Stable ordering by id; resume after the cursor, wrap to start at the end.
  const { data: setsRaw, error: setsErr } = await supabase
    .from("sets")
    .select("id, external_id")
    .eq("collection_id", COLLECTION_ID)
    .order("id", { ascending: true })
    .limit(2000)
  if (setsErr) {
    return NextResponse.json({ error: "sets read failed", detail: setsErr.message }, { status: 500 })
  }

  let candidateSets = (setsRaw as Array<{ id: string; external_id: string | null }>).filter(
    (s) => s.external_id && UUID_RE.test(s.external_id)
  )
  if (cursorSetId) {
    const idx = candidateSets.findIndex((s) => s.id === cursorSetId)
    if (idx >= 0) candidateSets = candidateSets.slice(idx + 1)
  }

  const timeBudgetMs = maxDuration * 1000 - TIME_BUDGET_OVERHEAD_MS
  const collected: FmvRow[] = []
  let setsProcessed = 0
  let editionsFetched = 0
  let lastSetId: string | null = null
  let firstGqlError: string | null = null
  let debugSample: unknown = null
  let terminatedReason = "no_more_sets"

  for (const setRow of candidateSets) {
    if (Date.now() - startedAt > timeBudgetMs) {
      terminatedReason = "time_budget_exceeded"
      break
    }
    const { editions, gqlError } = await walkSet(setRow.external_id as string)
    if (gqlError && !firstGqlError) firstGqlError = gqlError
    if (debugSample === null && editions.length > 0) debugSample = editions[0]
    for (const e of editions) {
      editionsFetched++
      const row = mapEdition(e)
      if (row) collected.push(row)
    }
    setsProcessed++
    lastSetId = setRow.id
    await sleep(SET_DELAY_MS)
  }

  // Wrap the cursor to NULL when the sweep reached the end of the set list.
  const sweepComplete = terminatedReason === "no_more_sets"
  const nextCursor = sweepComplete ? null : lastSetId

  // ── Write FMV through the RPC ──────────────────────────────────────────────
  let upserted = 0
  let skipped = 0
  let noEdition = 0
  let rpcError: string | null = null
  for (let i = 0; i < collected.length; i += RPC_CHUNK) {
    const chunk = collected.slice(i, i + RPC_CHUNK)
    const { data, error } = await supabase.rpc("upsert_topshot_marketplace_fmv", {
      p_rows: chunk,
    })
    if (error) {
      rpcError = error.message
      console.log(`[topshot-fmv-populate] rpc error: ${error.message}`)
      break
    }
    const row = Array.isArray(data) ? data[0] : data
    if (row && typeof row === "object") {
      upserted += Number((row as any).upserted ?? 0) || 0
      skipped += Number((row as any).skipped ?? 0) || 0
      noEdition += Number((row as any).no_edition ?? 0) || 0
    }
  }

  // ── Advance the cursor ────────────────────────────────────────────────────
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
  const ok = rpcError === null

  try {
    await supabase.from("pipeline_runs").insert({
      pipeline: PIPELINE_NAME,
      collection_slug: COLLECTION_SLUG,
      started_at: startedAtIso,
      finished_at: new Date().toISOString(),
      rows_found: editionsFetched,
      rows_written: upserted,
      rows_skipped: skipped,
      ok,
      error: rpcError,
      cursor_before: cursorSetId,
      cursor_after: nextCursor,
      extra: {
        sets_processed: setsProcessed,
        editions_fetched: editionsFetched,
        upserted,
        skipped,
        no_edition: noEdition,
        sweep_complete: sweepComplete,
        terminated_reason: terminatedReason,
        gql_error: firstGqlError,
        debug_node_sample: debugSample ? JSON.stringify(debugSample).slice(0, 400) : null,
        duration_ms: durationMs,
      },
    })
  } catch (e) {
    console.log(`[topshot-fmv-populate] pipeline_runs insert failed: ${e instanceof Error ? e.message : e}`)
  }

  return NextResponse.json({
    ok,
    pipeline: PIPELINE_NAME,
    sets_processed: setsProcessed,
    editions_fetched: editionsFetched,
    upserted,
    skipped,
    no_edition: noEdition,
    sweep_complete: sweepComplete,
    terminated_reason: terminatedReason,
    gql_error: firstGqlError,
    debug_node_sample: debugSample ? JSON.stringify(debugSample).slice(0, 400) : null,
    rpc_error: rpcError,
    duration_ms: durationMs,
  })
}

export async function GET(req: NextRequest) {
  return handle(req)
}

export async function POST(req: NextRequest) {
  return handle(req)
}
