import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import crypto from "crypto"

// ─────────────────────────────────────────────────────────────────────────────
// UFC Strike sales-history backfill via the Dapper studio-platform GQL.
//
// Discovery: docs/handoff-2026-06-24-studio-platform-gql-deep-history.md
//
// UFC is the one collection studio exposes with NO edition filter — the
// searchUFCMarketplaceHistory filter is set_id / base_filter only. So instead of
// a per-edition queue (AllDay/Golazos/Pinnacle), this is a single GLOBAL cursor
// walk over all purchased UFC rows (~860k), sorted block_time ASC (oldest first
// → new sales append at the tail, keeping the cursor stable across ticks; history
// reaches back to 2022-02-15, deeper than any other collection's studio floor).
//
// Each row carries nft.set.metadata.{athlete_name, edition_size} + nft.edition_num
// (serial) inline. We resolve to one of our 518 cataloged editions IN-PROCESS via
// a (lower(trim(athlete))|edition_size) → edition_id map (the SQL twin of
// resolve_ufc_edition_by_studio_meta; 0 ambiguous keys, verified). Rows for
// uncataloged editions / packs (athlete/size null) resolve to nothing → skipped.
//
// KEYING / SAFETY (mirrors the shared studio drain):
//   • Writes `sales` with source='ufc_studio_history_v1', edition_id = resolved.
//   • Dedup by transaction_hash (one row/tx, the established convention) against
//     existing sales + a 23505 row-by-row fallback → augments the forward
//     indexer + on-chain rows, never doubles.
//   • Cursor checkpointed every CHECKPOINT_PAGES pages AFTER its matched sales are
//     written, so the persisted cursor never runs ahead of written rows (a crash
//     re-walks at most one checkpoint, idempotently).
//   • Self-throttle on platform saturation; synchronous (no after()/waitUntil).
//
// Kill switch: disable the cron OR set UFC_STUDIO_SALES_HISTORY_BACKFILL_DISABLED=1.
// Modes: ?dryRun=true&pages=N (probe from a fresh cursor, write nothing),
//        ?reset=true (restart the walk from the beginning).
// Revert: DELETE FROM sales WHERE source='ufc_studio_history_v1';
//         + DROP TABLE public.ufc_studio_sales_history_state;
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic"
export const maxDuration = 300

const PIPELINE = "ufc-studio-sales-history-backfill"
const COLLECTION_ID = "9b4824a8-736d-4a96-b450-8dcc0c46b023"
const COLLECTION_SLUG = "ufc_strike"
const MARKETPLACE = "ufcstrike"
const SOURCE_TAG = "ufc_studio_history_v1"
const STATE_TABLE = "ufc_studio_sales_history_state"
const DISABLE_ENV = "UFC_STUDIO_SALES_HISTORY_BACKFILL_DISABLED"

const GQL = "https://api.production.studio-platform.dapperlabs.com/graphql"
const GQL_HEADERS = {
  "Content-Type": "application/json",
  "User-Agent": "RipPacksCity/1.0 (www.rippackscity.com)",
  Origin: "https://ufcstrike.com",
  Referer: "https://ufcstrike.com/",
}

const PAGE_SIZE = 200
const ELAPSED_BUDGET_MS = 200_000
const MAX_PAGES_PER_TICK = 600
const PER_REQUEST_TIMEOUT_MS = 20_000
const INTER_PAGE_DELAY_MS = 100
const CHECKPOINT_PAGES = 40 // flush matched sales + persist cursor this often
const INSERT_CHUNK = 200
const READ_CHUNK = 200
const SATURATION_FAIL_THRESHOLD = 15

const HISTORY_QUERY = `
query UFCHistory($in: SearchUFCMarketplaceHistoryInput!) {
  searchUFCMarketplaceHistory(searchInput: $in) {
    totalCount
    pageInfo { endCursor hasNextPage }
    edges { node {
      nft_id sales_price price purchased receiver_address
      created_at { block_height block_time transaction_hash }
      nft { edition_num set { metadata { athlete_name edition_size } } }
    } }
  }
}`

// block_time ASC keeps the multi-tick walk stable (new sales append at the tail).
const SORT = { created_at: { block_time: { priority: 0, direction: "ASC" } } }
const FILTERS = [{ base_filter: { purchased: { eq: true } } }]

interface HistNode {
  nft_id: string | null
  sales_price: string | null
  price: string | null
  purchased: boolean | null
  receiver_address: string | null
  created_at: { block_height: string | null; block_time: string | null; transaction_hash: string | null } | null
  nft: { edition_num: string | null; set: { metadata: { athlete_name: string | null; edition_size: string | null } | null } | null } | null
}

type SaleRow = {
  id: string
  edition_id: string
  collection_id: string
  collection: string
  nft_id: string | null
  serial_number: number
  price_usd: number
  currency: string
  marketplace: string
  source: string
  block_height: number | null
  transaction_hash: string
  sold_at: string
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}
function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
function keyFor(athlete: string | null | undefined, size: string | null | undefined): string | null {
  if (!athlete || size === null || size === undefined || size === "") return null
  const circ = toNum(size)
  if (circ === null) return null
  return `${athlete.trim().toLowerCase()}|${circ}`
}

async function fetchPage(
  after: string | null,
): Promise<{ total: number; nodes: HistNode[]; endCursor: string | null; hasNextPage: boolean }> {
  const variables: { in: { first: number; after?: string; sortBy: typeof SORT; filters: typeof FILTERS } } = {
    in: { first: PAGE_SIZE, sortBy: SORT, filters: FILTERS },
  }
  if (after) variables.in.after = after
  const res = await fetch(GQL, {
    method: "POST",
    headers: GQL_HEADERS,
    body: JSON.stringify({ query: HISTORY_QUERY, variables }),
    signal: AbortSignal.timeout(PER_REQUEST_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`GQL ${res.status}`)
  const json = (await res.json()) as {
    data?: { searchUFCMarketplaceHistory?: { totalCount: number; pageInfo: { endCursor: string | null; hasNextPage: boolean }; edges: Array<{ node: HistNode }> } }
    errors?: Array<{ message: string }>
  }
  if (Array.isArray(json.errors) && json.errors.length > 0) throw new Error(`GQL: ${json.errors[0]?.message ?? "error"}`)
  const conn = json.data?.searchUFCMarketplaceHistory
  if (!conn) throw new Error("GQL: empty response")
  return {
    total: conn.totalCount ?? 0,
    nodes: (conn.edges ?? []).map((e) => e.node).filter(Boolean),
    endCursor: conn.pageInfo?.endCursor ?? null,
    hasNextPage: conn.pageInfo?.hasNextPage === true,
  }
}

// Build the (athlete_lower|circ) → edition_id map for our 518 cataloged UFC
// editions. Ambiguous keys (none today) map to null so they are never written.
async function loadEditionMap(): Promise<Map<string, string | null>> {
  const map = new Map<string, string | null>()
  const { data, error } = await supabaseAdmin
    .from("editions")
    .select("id, player_name, circulation_count")
    .eq("collection_id", COLLECTION_ID)
    .not("player_name", "is", null)
    .not("circulation_count", "is", null)
  if (error) throw new Error(`edition_map: ${error.message}`)
  for (const e of (data ?? []) as Array<{ id: string; player_name: string; circulation_count: number }>) {
    const k = keyFor(e.player_name, String(e.circulation_count))
    if (!k) continue
    if (map.has(k)) map.set(k, null) // collision → ambiguous, skip
    else map.set(k, e.id)
  }
  return map
}

// Dedup the matched candidates against existing sales (by transaction_hash) and
// insert the new rows. Returns {inserted, dupes}.
async function flushCandidates(candidates: Map<string, SaleRow>): Promise<{ inserted: number; dupes: number }> {
  if (candidates.size === 0) return { inserted: 0, dupes: 0 }
  const hashes = Array.from(candidates.keys())
  const existing = new Set<string>()
  for (let i = 0; i < hashes.length; i += READ_CHUNK) {
    const chunk = hashes.slice(i, i + READ_CHUNK)
    const { data, error } = await supabaseAdmin.from("sales").select("transaction_hash").in("transaction_hash", chunk)
    if (error) throw new Error(`existing_read: ${error.message.slice(0, 160)}`)
    for (const r of (data ?? []) as Array<{ transaction_hash: string | null }>) if (r.transaction_hash) existing.add(r.transaction_hash)
  }
  const toInsert: SaleRow[] = []
  let dupes = 0
  for (const row of candidates.values()) {
    if (existing.has(row.transaction_hash)) dupes++
    else toInsert.push(row)
  }
  let inserted = 0
  for (let i = 0; i < toInsert.length; i += INSERT_CHUNK) {
    const chunk = toInsert.slice(i, i + INSERT_CHUNK)
    const { error } = await supabaseAdmin.from("sales").insert(chunk)
    if (!error) {
      inserted += chunk.length
      continue
    }
    if (error.code === "23505" || error.message.includes("duplicate")) {
      for (const row of chunk) {
        const { error: rowErr } = await supabaseAdmin.from("sales").insert(row)
        if (!rowErr) inserted++
        else if (rowErr.code === "23505" || rowErr.message.includes("duplicate")) dupes++
        else throw new Error(`insert: ${rowErr.message.slice(0, 160)}`)
      }
      continue
    }
    throw new Error(`insert: ${error.message.slice(0, 160)}`)
  }
  return { inserted, dupes }
}

async function logRun(
  startedAt: string,
  startedMs: number,
  ok: boolean,
  found: number,
  written: number,
  skipped: number,
  errMsg: string | null,
  extra: Record<string, unknown>,
) {
  try {
    await supabaseAdmin.rpc("log_pipeline_run", {
      p_pipeline: PIPELINE,
      p_started_at: startedAt,
      p_rows_found: found,
      p_rows_written: written,
      p_rows_skipped: skipped,
      p_ok: ok,
      p_error: errMsg,
      p_collection_slug: COLLECTION_SLUG,
      p_extra: { ...extra, duration_ms: Date.now() - startedMs },
    })
  } catch (e) {
    console.log(`[${PIPELINE}] log_pipeline_run err: ${e instanceof Error ? e.message : String(e)}`)
  }
}

async function run(req: NextRequest): Promise<NextResponse> {
  const auth = req.headers.get("authorization") ?? ""
  const bearer = auth.replace(/^Bearer\s+/i, "")
  const urlToken = req.nextUrl.searchParams.get("token") ?? ""
  const TOKEN = process.env.INGEST_SECRET_TOKEN ?? ""
  const CRON = process.env.CRON_SECRET ?? ""
  const authedOk =
    (TOKEN.length > 0 && (bearer === TOKEN || urlToken === TOKEN)) ||
    (CRON.length > 0 && (bearer === CRON || urlToken === CRON))
  if (!authedOk) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const startedAt = new Date().toISOString()
  const startedMs = Date.now()

  if (process.env[DISABLE_ENV] === "1" || process.env[DISABLE_ENV] === "true") {
    await logRun(startedAt, startedMs, true, 0, 0, 0, null, { skipped: "disabled" })
    return NextResponse.json({ ok: true, skipped: "disabled", pipeline: PIPELINE }, { status: 200 })
  }

  const dryRun = req.nextUrl.searchParams.get("dryRun") === "true"
  const reset = req.nextUrl.searchParams.get("reset") === "true"

  if (reset) {
    const { error } = await supabaseAdmin
      .from(STATE_TABLE)
      .update({ after_cursor: null, pages_walked: 0, rows_scanned: 0, rows_matched: 0, sales_inserted: 0, done: false, error: null, last_block_time: null, updated_at: new Date().toISOString() })
      .eq("id", 1)
    if (error) return NextResponse.json({ ok: false, mode: "reset", error: error.message }, { status: 500 })
    await logRun(startedAt, startedMs, true, 0, 0, 0, null, { mode: "reset" })
    return NextResponse.json({ ok: true, mode: "reset", pipeline: PIPELINE }, { status: 200 })
  }

  // ── Dry-run: walk N pages from a FRESH cursor, resolve, write NOTHING ─────────
  if (dryRun) {
    const pages = Math.min(toNum(req.nextUrl.searchParams.get("pages")) ?? 3, 20)
    try {
      const map = await loadEditionMap()
      let after: string | null = null
      let total = 0
      let scanned = 0
      let matched = 0
      let walked = 0
      const sample: Array<{ athlete: string | null; size: string | null; price: number | null; soldAt: string | null; matched: boolean }> = []
      for (let i = 0; i < pages; i++) {
        const page = await fetchPage(after)
        walked++
        total = Math.max(total, page.total)
        for (const n of page.nodes) {
          scanned++
          const k = keyFor(n.nft?.set?.metadata?.athlete_name, n.nft?.set?.metadata?.edition_size)
          const edId = k ? map.get(k) ?? null : null
          const isMatch = !!edId && n.purchased === true && !!n.created_at?.transaction_hash
          if (isMatch) matched++
          if (sample.length < 8 && k && map.has(k))
            sample.push({ athlete: n.nft?.set?.metadata?.athlete_name ?? null, size: n.nft?.set?.metadata?.edition_size ?? null, price: toNum(n.sales_price ?? n.price), soldAt: n.created_at?.block_time ?? null, matched: isMatch })
        }
        if (!page.hasNextPage || !page.endCursor) break
        after = page.endCursor
        await delay(INTER_PAGE_DELAY_MS)
      }
      return NextResponse.json({ ok: true, mode: "dryRun", pages: walked, studio_total: total, scanned, matched, edition_map_size: map.size, sample }, { status: 200 })
    } catch (e) {
      return NextResponse.json({ ok: false, mode: "dryRun", error: e instanceof Error ? e.message : String(e) }, { status: 500 })
    }
  }

  // ── Self-throttle on platform saturation ─────────────────────────────────────
  try {
    const since = new Date(Date.now() - 30 * 60 * 1000).toISOString()
    const { count } = await supabaseAdmin
      .from("pipeline_runs")
      .select("id", { count: "exact", head: true })
      .eq("ok", false)
      .neq("pipeline", PIPELINE)
      .gte("finished_at", since)
    if ((count ?? 0) > SATURATION_FAIL_THRESHOLD) {
      await logRun(startedAt, startedMs, true, 0, 0, 0, null, { skipped: "saturation", recent_fails: count })
      return NextResponse.json({ ok: true, skipped: "saturation", recent_fails: count, pipeline: PIPELINE }, { status: 200 })
    }
  } catch (e) {
    await logRun(startedAt, startedMs, false, 0, 0, 0, `throttle_read: ${e instanceof Error ? e.message : String(e)}`, {})
    return NextResponse.json({ ok: false, skipped: "throttle_error", pipeline: PIPELINE }, { status: 200 })
  }

  // ── Load resume state ────────────────────────────────────────────────────────
  const { data: stateRow, error: stateErr } = await supabaseAdmin
    .from(STATE_TABLE)
    .select("after_cursor, pages_walked, rows_scanned, rows_matched, sales_inserted, done")
    .eq("id", 1)
    .maybeSingle()
  if (stateErr) {
    await logRun(startedAt, startedMs, false, 0, 0, 0, `state_read: ${stateErr.message}`, {})
    return NextResponse.json({ ok: false, error: stateErr.message, pipeline: PIPELINE }, { status: 500 })
  }
  if (stateRow?.done) {
    await logRun(startedAt, startedMs, true, 0, 0, 0, null, { note: "walk_complete" })
    return NextResponse.json({ ok: true, note: "walk_complete", pipeline: PIPELINE }, { status: 200 })
  }

  let map: Map<string, string | null>
  try {
    map = await loadEditionMap()
  } catch (e) {
    await logRun(startedAt, startedMs, false, 0, 0, 0, e instanceof Error ? e.message : String(e), {})
    return NextResponse.json({ ok: false, error: "edition_map", pipeline: PIPELINE }, { status: 500 })
  }

  let after: string | null = (stateRow?.after_cursor as string | null) ?? null
  const totalPagesWalked0 = Number(stateRow?.pages_walked ?? 0)
  const totalScanned0 = Number(stateRow?.rows_scanned ?? 0)
  const totalMatched0 = Number(stateRow?.rows_matched ?? 0)
  const totalInserted0 = Number(stateRow?.sales_inserted ?? 0)

  let pagesThisTick = 0
  let scannedThisTick = 0
  let matchedThisTick = 0
  let insertedThisTick = 0
  let dupesThisTick = 0
  let studioTotal = 0
  let lastBlockTime: string | null = null
  let walkDone = false
  let budgetHit = false
  let cursorSinceCheckpoint: string | null = after
  let candidates = new Map<string, SaleRow>()
  let pagesSinceCheckpoint = 0
  let runError: string | null = null

  // Persist matched sales (already accumulated) THEN advance the cursor, so the
  // saved cursor never outruns written rows.
  async function checkpoint(cursor: string | null) {
    const flushed = await flushCandidates(candidates)
    insertedThisTick += flushed.inserted
    dupesThisTick += flushed.dupes
    candidates = new Map()
    await supabaseAdmin
      .from(STATE_TABLE)
      .update({
        after_cursor: cursor,
        pages_walked: totalPagesWalked0 + pagesThisTick,
        rows_scanned: totalScanned0 + scannedThisTick,
        rows_matched: totalMatched0 + matchedThisTick,
        sales_inserted: totalInserted0 + insertedThisTick,
        studio_total: studioTotal || null,
        last_block_time: lastBlockTime,
        done: walkDone,
        error: null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", 1)
    pagesSinceCheckpoint = 0
  }

  try {
    for (let i = 0; i < MAX_PAGES_PER_TICK; i++) {
      if (Date.now() - startedMs > ELAPSED_BUDGET_MS) {
        budgetHit = true
        break
      }
      const page = await fetchPage(after)
      pagesThisTick++
      pagesSinceCheckpoint++
      studioTotal = Math.max(studioTotal, page.total)
      for (const n of page.nodes) {
        scannedThisTick++
        if (n.purchased !== true) continue
        const tx = n.created_at?.transaction_hash
        if (!tx) continue
        const soldAt = n.created_at?.block_time
        if (!soldAt) continue
        lastBlockTime = soldAt
        const k = keyFor(n.nft?.set?.metadata?.athlete_name, n.nft?.set?.metadata?.edition_size)
        if (!k) continue
        const edId = map.get(k) ?? null
        if (!edId) continue // uncataloged or ambiguous → skip
        const priceDuc = toNum(n.sales_price ?? n.price)
        if (priceDuc === null || priceDuc <= 0) continue
        matchedThisTick++
        if (candidates.has(tx)) continue
        candidates.set(tx, {
          id: crypto.randomUUID(),
          edition_id: edId,
          collection_id: COLLECTION_ID,
          collection: COLLECTION_SLUG,
          nft_id: n.nft_id ? String(n.nft_id) : null,
          serial_number: toNum(n.nft?.edition_num) ?? 0,
          price_usd: priceDuc / 1e8, // DUC UInt64 → USD
          currency: "USD",
          marketplace: MARKETPLACE,
          source: SOURCE_TAG,
          block_height: toNum(n.created_at?.block_height),
          transaction_hash: tx,
          sold_at: soldAt,
        })
      }

      cursorSinceCheckpoint = page.endCursor
      if (!page.hasNextPage || !page.endCursor) {
        walkDone = true
        await checkpoint(page.endCursor)
        break
      }
      after = page.endCursor
      if (pagesSinceCheckpoint >= CHECKPOINT_PAGES) {
        await checkpoint(after)
      }
      await delay(INTER_PAGE_DELAY_MS)
    }

    // Flush whatever's left + persist final cursor for this tick.
    if (!walkDone) await checkpoint(cursorSinceCheckpoint)
  } catch (e) {
    runError = e instanceof Error ? e.message.slice(0, 200) : String(e)
    // Best-effort: persist progress up to the last successfully-fetched page so we
    // don't lose the whole tick. Candidates not yet flushed are re-found next tick.
    try {
      await supabaseAdmin
        .from(STATE_TABLE)
        .update({ pages_walked: totalPagesWalked0 + pagesThisTick, rows_scanned: totalScanned0 + scannedThisTick, error: runError, updated_at: new Date().toISOString() })
        .eq("id", 1)
    } catch {
      /* non-fatal */
    }
  }

  const ok = runError === null
  await logRun(startedAt, startedMs, ok, scannedThisTick, insertedThisTick, dupesThisTick, runError, {
    pages_this_tick: pagesThisTick,
    matched_this_tick: matchedThisTick,
    walk_done: walkDone,
    budget_hit: budgetHit,
    studio_total: studioTotal,
    last_block_time: lastBlockTime,
    cumulative_inserted: totalInserted0 + insertedThisTick,
  })

  return NextResponse.json(
    {
      ok,
      pipeline: PIPELINE,
      pages_this_tick: pagesThisTick,
      scanned_this_tick: scannedThisTick,
      matched_this_tick: matchedThisTick,
      sales_inserted: insertedThisTick,
      dupes_skipped: dupesThisTick,
      walk_done: walkDone,
      budget_hit: budgetHit,
      studio_total: studioTotal,
      last_block_time: lastBlockTime,
      cumulative_inserted: totalInserted0 + insertedThisTick,
      error: runError,
    },
    { status: ok ? 200 : 500 },
  )
}

export async function POST(req: NextRequest) {
  return run(req)
}
export async function GET(req: NextRequest) {
  return run(req)
}
