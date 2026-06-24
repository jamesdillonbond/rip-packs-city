import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { fireNextPipelineStep } from "@/lib/pipeline-chain"

// ─────────────────────────────────────────────────────────────────────────────
// Disney Pinnacle sales-history backfill — closes the native pre-indexer gap.
//
// Program: docs/handoff-2026-06-24-historical-sales-capture-program.md (priority #2)
//
// CORRECTION baked in (handoff, tested 2026-06-24): Pinnacle native sales are
// ON-CHAIN, not GQL — the studio-platform GQL serves catalog/render/image only,
// NOT sale history. So this is mechanism (B): walk the V2 Dapper storefront
// ListingCompleted events backward, exactly like pinnacle-sales-indexer but in
// reverse. Pinnacle was never on Flowty, so there is a single event source.
//
// The forward pinnacle-sales-indexer's earliest captured sale is 2026-03-03; its
// rows carry NO block_height (pinnacle_sales has no such column), so the ceiling
// is the block at ~2026-03-03 — found once via a runtime block-bisect and cached
// in the cursor. Walk DOWN from there to the current spork floor (2025-12-29);
// the deeper tail (<2025-12-29) is below the floor → spork-proxy (separate
// gated workstream; this route stops + reports at the floor).
//
// SAFETY RAILS (mirrors allday/topshot-sales-history-backfill):
//   • SYNCHRONOUS, no after()/waitUntil. Self-budgets to ~200s under the ~300s cap.
//   • Self-throttle on >15 recent non-self pipeline fails.
//   • Idempotent: pinnacle_sales dedup is the text PK id=`${tx}_${nft}` (upsert
//     ignoreDuplicates) — overlap with the forward indexer is harmless. Every
//     backfilled row is tagged source='on-chain-history-backfill' so REVERT is one
//     bounded DELETE:  DELETE FROM pinnacle_sales WHERE source='on-chain-history-backfill';
//   • Dynamic spork-floor detection (404 "is less than" → stop + report).
//
// Kill switch: disable the cron OR set PINNACLE_SALES_HISTORY_BACKFILL_DISABLED=1
// ─────────────────────────────────────────────────────────────────────────────

export const dynamic = "force-dynamic"
export const maxDuration = 300

const TOKEN = process.env.INGEST_SECRET_TOKEN ?? ""
const PINNACLE_COLLECTION_ID = "7dd9dd11-e8b6-45c4-ac99-71331f959714"
const COLLECTION_SLUG = "disney_pinnacle"
const PIPELINE_NAME = "pinnacle-sales-history-backfill"
const CURSOR_ID = "pinnacle_sales_backfill"
const BACKFILL_SOURCE = "on-chain-history-backfill"

// The forward indexer's earliest captured sale is 2026-03-03; find the block at
// just above that (overlap is dedup-safe) once via bisect, then cache in cursor.
const CEILING_DATE_ISO = "2026-03-04T00:00:00Z"
const SPORK_FLOOR_HINT = 137_390_146

const STOREFRONT_EVENT = "A.4eb8a10cb9f87357.NFTStorefrontV2.ListingCompleted"
const PINNACLE_TYPE_MATCH = "Pinnacle"

const FLOW_REST = "https://rest-mainnet.onflow.org"
const CHUNK_SIZE = 250
const SCAN_RANGE = 40_000
const INTER_CHUNK_DELAY_MS = 60

const ELAPSED_BUDGET_MS = 200_000
const HARD_CAP_MS = 250_000

const SATURATION_FAIL_THRESHOLD = 15

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
}
function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

function unwrapCdc(node: unknown): unknown {
  if (node === null || node === undefined) return node
  if (Array.isArray(node)) return node.map(unwrapCdc)
  if (typeof node !== "object") return node
  const { type, value } = node as { type?: string; value?: unknown }
  if (type !== undefined && value !== undefined) {
    switch (type) {
      case "Optional":
        return value === null ? null : unwrapCdc(value)
      case "Array":
        return (value as unknown[]).map(unwrapCdc)
      case "Dictionary": {
        const out: Record<string, unknown> = {}
        for (const kv of value as Array<{ key: unknown; value: unknown }>) {
          out[String(unwrapCdc(kv.key))] = unwrapCdc(kv.value)
        }
        return out
      }
      case "Struct":
      case "Resource":
      case "Event":
      case "Contract":
      case "Enum": {
        const out: Record<string, unknown> = {}
        const fields = (value as { fields?: Array<{ name: string; value: unknown }> }).fields ?? []
        for (const f of fields) out[f.name] = unwrapCdc(f.value)
        return out
      }
      case "Type":
        return { staticType: (value as { staticType?: unknown }).staticType }
      default:
        return value
    }
  }
  return node
}

interface FlowEventBlock {
  block_id: string
  block_height: string
  block_timestamp: string
  events?: Array<{ type: string; transaction_id: string; payload: string; event_index: number }>
}

async function fetchEventRange(
  type: string,
  start: number,
  end: number,
): Promise<{ blocks: FlowEventBlock[]; belowFloor: boolean }> {
  const url = `${FLOW_REST}/v1/events?type=${encodeURIComponent(type)}&start_height=${start}&end_height=${end}`
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) })
    if (!res.ok) {
      const body = (await res.text()).slice(0, 200)
      const belowFloor = res.status === 404 && /is less than/i.test(body)
      if (!belowFloor) console.log(`[${PIPELINE_NAME}] events ${start}-${end} HTTP ${res.status}: ${body}`)
      return { blocks: [], belowFloor }
    }
    const json = (await res.json()) as FlowEventBlock[]
    return { blocks: Array.isArray(json) ? json : [], belowFloor: false }
  } catch (e) {
    console.log(`[${PIPELINE_NAME}] events ${start}-${end} err: ${e instanceof Error ? e.message : String(e)}`)
    return { blocks: [], belowFloor: false }
  }
}

async function getLatestSealedHeight(): Promise<number> {
  const res = await fetch(`${FLOW_REST}/v1/blocks?height=sealed`, { signal: AbortSignal.timeout(8000) })
  if (!res.ok) throw new Error(`blocks sealed HTTP ${res.status}`)
  const json = (await res.json()) as Array<{ header: { height: string } }>
  return Number(json[0]?.header?.height ?? 0)
}

async function blockTimestampMs(height: number): Promise<number | null> {
  try {
    const res = await fetch(`${FLOW_REST}/v1/blocks?height=${height}`, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) return null
    const json = (await res.json()) as Array<{ header?: { timestamp?: string } }>
    const ts = json[0]?.header?.timestamp
    return ts ? Date.parse(ts) : null
  } catch {
    return null
  }
}

// Binary-search the lowest block whose timestamp >= targetIso, within
// [SPORK_FLOOR_HINT, sealed]. ~25 REST calls; runs once on first init.
async function bisectBlockForDate(targetIso: string): Promise<number> {
  const targetMs = Date.parse(targetIso)
  let lo = SPORK_FLOOR_HINT
  let hi = await getLatestSealedHeight()
  let iter = 0
  while (lo < hi && iter < 40) {
    iter++
    const mid = Math.floor((lo + hi) / 2)
    const ts = await blockTimestampMs(mid)
    if (ts === null) {
      lo = mid + 1
      continue
    }
    if (ts < targetMs) lo = mid + 1
    else hi = mid
  }
  return lo
}

interface Sale {
  blockHeight: number
  blockTimestamp: string
  transactionId: string
  nftID: string
  salePrice: string
  commissionReceiver: string | null
}

async function logRun(
  startedAt: string,
  startedMs: number,
  ok: boolean,
  found: number,
  written: number,
  skipped: number,
  errMsg: string | null,
  cursorBefore: string | null,
  cursorAfter: string | null,
  extra: Record<string, unknown>,
) {
  try {
    await supabaseAdmin.rpc("log_pipeline_run", {
      p_pipeline: PIPELINE_NAME,
      p_started_at: startedAt,
      p_rows_found: found,
      p_rows_written: written,
      p_rows_skipped: skipped,
      p_ok: ok,
      p_error: errMsg,
      p_collection_slug: COLLECTION_SLUG,
      p_cursor_before: cursorBefore,
      p_cursor_after: cursorAfter,
      p_extra: { ...extra, duration_ms: Date.now() - startedMs },
    })
  } catch (e) {
    console.log(`[${PIPELINE_NAME}] log_pipeline_run err: ${e instanceof Error ? e.message : String(e)}`)
  }
}

async function scanRange(
  start: number,
  end: number,
  deadlineMs: number,
  counters: Record<string, number>,
): Promise<{ sales: Sale[]; belowFloor: boolean }> {
  const sales: Sale[] = []
  let belowFloor = false
  for (let s = start; s <= end; s += CHUNK_SIZE) {
    if (Date.now() > deadlineMs) break
    const e = Math.min(s + CHUNK_SIZE - 1, end)
    const res = await fetchEventRange(STOREFRONT_EVENT, s, e)
    if (res.belowFloor) {
      belowFloor = true
      break
    }
    for (const blk of res.blocks) {
      const bh = Number(blk.block_height)
      const bts = blk.block_timestamp
      for (const evt of blk.events ?? []) {
        counters.raw = (counters.raw ?? 0) + 1
        try {
          const payload = unwrapCdc(JSON.parse(Buffer.from(evt.payload, "base64").toString("utf8"))) as Record<string, any>
          const typeID: string | undefined = payload?.nftType?.staticType?.typeID
          if (!typeID || !typeID.includes(PINNACLE_TYPE_MATCH)) continue
          if (payload.purchased !== true) continue
          sales.push({
            blockHeight: bh,
            blockTimestamp: bts,
            transactionId: evt.transaction_id,
            nftID: String(payload.nftID),
            salePrice: String(payload.salePrice ?? "0"),
            commissionReceiver: typeof payload.commissionReceiver === "string" ? payload.commissionReceiver : null,
          })
          counters.pinnacleIn = (counters.pinnacleIn ?? 0) + 1
        } catch {
          /* skip */
        }
      }
    }
    if (s + CHUNK_SIZE <= end) await delay(INTER_CHUNK_DELAY_MS)
  }
  return { sales, belowFloor }
}

async function run(req: NextRequest): Promise<NextResponse> {
  const auth = req.headers.get("authorization") ?? ""
  const bearer = auth.replace(/^Bearer\s+/i, "")
  const urlToken = req.nextUrl.searchParams.get("token") ?? ""
  const CRON = process.env.CRON_SECRET ?? ""
  const authedOk =
    (TOKEN.length > 0 && (bearer === TOKEN || urlToken === TOKEN)) ||
    (CRON.length > 0 && (bearer === CRON || urlToken === CRON))
  if (!authedOk) return unauthorized()

  const startedAt = new Date().toISOString()
  const startedMs = Date.now()

  const disabled =
    process.env.PINNACLE_SALES_HISTORY_BACKFILL_DISABLED === "1" ||
    process.env.PINNACLE_SALES_HISTORY_BACKFILL_DISABLED === "true"
  if (disabled) {
    await logRun(startedAt, startedMs, true, 0, 0, 0, null, null, null, { skipped: "disabled" })
    return NextResponse.json({ ok: true, skipped: "disabled", pipeline: PIPELINE_NAME }, { status: 200 })
  }

  const dryRun = req.nextUrl.searchParams.get("dryRun") === "true"
  const rangeOverride = Number(req.nextUrl.searchParams.get("range") ?? SCAN_RANGE)
  const scanWindow = Math.min(Math.max(rangeOverride || SCAN_RANGE, CHUNK_SIZE), 60_000)

  if (!dryRun) {
    try {
      const since = new Date(Date.now() - 30 * 60 * 1000).toISOString()
      const { count } = await supabaseAdmin
        .from("pipeline_runs")
        .select("id", { count: "exact", head: true })
        .eq("ok", false)
        .neq("pipeline", PIPELINE_NAME)
        .gte("finished_at", since)
      if ((count ?? 0) > SATURATION_FAIL_THRESHOLD) {
        await logRun(startedAt, startedMs, true, 0, 0, 0, null, null, null, { skipped: "saturation", recent_fails: count })
        return NextResponse.json({ ok: true, skipped: "saturation", recent_fails: count }, { status: 200 })
      }
    } catch (e) {
      await logRun(startedAt, startedMs, false, 0, 0, 0, `throttle_read: ${e instanceof Error ? e.message : String(e)}`, null, null, {})
      return NextResponse.json({ ok: false, skipped: "throttle_error" }, { status: 200 })
    }
  }

  // ── Resolve the backward cursor (bisect the ceiling once on first init) ──────
  let ceiling: number
  if (dryRun) {
    const c = Number(req.nextUrl.searchParams.get("ceiling") ?? 0)
    ceiling = Number.isFinite(c) && c > 0 ? c : await bisectBlockForDate(CEILING_DATE_ISO)
  } else {
    const { data: cursorRow } = await supabaseAdmin
      .from("event_cursor")
      .select("last_processed_block")
      .eq("id", CURSOR_ID)
      .maybeSingle()
    if (cursorRow && Number(cursorRow.last_processed_block) > 0) {
      ceiling = Number(cursorRow.last_processed_block)
    } else {
      try {
        ceiling = await bisectBlockForDate(CEILING_DATE_ISO)
      } catch (e) {
        await logRun(startedAt, startedMs, false, 0, 0, 0, `bisect_failed: ${e instanceof Error ? e.message : String(e)}`, null, null, {})
        return NextResponse.json({ ok: false, error: "bisect_failed" }, { status: 200 })
      }
    }
  }

  const end = ceiling - 1
  const start = Math.max(SPORK_FLOOR_HINT, ceiling - scanWindow)
  const cursorBefore = String(ceiling)

  if (end < SPORK_FLOOR_HINT) {
    await logRun(startedAt, startedMs, true, 0, 0, 0, null, cursorBefore, cursorBefore, {
      note: "reached_spork_floor_hint",
      next: "deeper history (<2025-12-29) needs spork-proxy",
    })
    return NextResponse.json({ ok: true, note: "reached_spork_floor", floor: SPORK_FLOOR_HINT }, { status: 200 })
  }

  const counters: Record<string, number> = {}
  const hardDeadline = startedMs + HARD_CAP_MS
  let ok = true
  let errorMsg: string | null = null
  let rowsFound = 0
  let rowsWritten = 0
  let rowsSkipped = 0
  let belowFloor = false
  const extra: Record<string, unknown> = {}

  try {
    const scan = await scanRange(start, end, hardDeadline, counters)
    belowFloor = scan.belowFloor
    const sales = scan.sales
    rowsFound = sales.length

    if (dryRun) {
      const sample = sales.slice(0, 8).map((s) => ({
        nft: s.nftID,
        date: s.blockTimestamp.slice(0, 10),
        price: s.salePrice,
        buyer: s.commissionReceiver,
      }))
      return NextResponse.json(
        { ok: true, mode: "dryRun", scanned: `${start}-${end}`, ceiling, blocks: end - start + 1, found: sales.length, counters, belowFloor, sample },
        { status: 200 },
      )
    }

    // ── Resolve nftID → edition_key via pinnacle_nft_map → wmc ──────────────────
    const uniqueNftIds = [...new Set(sales.map((s) => s.nftID))]
    const nftToEditionKey = new Map<string, string>()
    for (let i = 0; i < uniqueNftIds.length; i += 500) {
      const batch = uniqueNftIds.slice(i, i + 500)
      const { data } = await supabaseAdmin
        .from("pinnacle_nft_map")
        .select("nft_id, edition_key")
        .in("nft_id", batch)
      for (const row of (data ?? []) as Array<{ nft_id: string; edition_key: string | null }>) {
        if (row.edition_key) nftToEditionKey.set(String(row.nft_id), row.edition_key)
      }
    }
    const stillUnresolved = uniqueNftIds.filter((id) => !nftToEditionKey.has(id))
    for (let i = 0; i < stillUnresolved.length; i += 500) {
      const batch = stillUnresolved.slice(i, i + 500)
      const { data } = await supabaseAdmin
        .from("wallet_moments_cache")
        .select("moment_id, edition_key")
        .eq("collection_id", PINNACLE_COLLECTION_ID)
        .in("moment_id", batch)
      for (const row of (data ?? []) as Array<{ moment_id: string; edition_key: string | null }>) {
        if (row.edition_key) nftToEditionKey.set(row.moment_id, row.edition_key)
      }
    }

    // ── Build + upsert pinnacle_sales (unresolved rows insert with null edition) ─
    const rows = sales.map((s) => ({
      id: `${s.transactionId}_${s.nftID}`,
      edition_id: nftToEditionKey.get(s.nftID) ?? null,
      nft_id: s.nftID,
      sale_price_usd: parseFloat(s.salePrice) || 0,
      serial_number: null,
      sold_at: s.blockTimestamp,
      source: BACKFILL_SOURCE,
      buyer_address: s.commissionReceiver ?? null,
      seller_address: null,
    }))

    let unresolvedCount = 0
    for (const r of rows) if (!r.edition_id) unresolvedCount++

    for (let i = 0; i < rows.length; i += 100) {
      const batch = rows.slice(i, i + 100)
      const { error } = await supabaseAdmin
        .from("pinnacle_sales")
        .upsert(batch, { onConflict: "id", ignoreDuplicates: true })
      if (!error) {
        rowsWritten += batch.length
      } else if (error.code === "23505") {
        rowsSkipped += batch.length
      } else {
        console.log(`[${PIPELINE_NAME}] pinnacle_sales upsert err: ${error.message}`)
        for (const row of batch) {
          const { error: se } = await supabaseAdmin
            .from("pinnacle_sales")
            .upsert(row, { onConflict: "id", ignoreDuplicates: true })
          if (!se) rowsWritten++
          else rowsSkipped++
        }
      }
    }

    await supabaseAdmin
      .from("event_cursor")
      .upsert(
        { id: CURSOR_ID, last_processed_block: start, updated_at: new Date().toISOString() },
        { onConflict: "id" },
      )

    extra.scanned = `${start}-${end}`
    extra.ceiling = ceiling
    extra.blocks = end - start + 1
    extra.unresolved_editions = unresolvedCount
    extra.below_floor = belowFloor
    Object.assign(extra, counters)
  } catch (err) {
    ok = false
    errorMsg = err instanceof Error ? err.message : String(err)
    console.log(`[${PIPELINE_NAME}] fatal: ${errorMsg}`)
  }

  if (!dryRun) {
    const cursorAfter = String(Math.max(SPORK_FLOOR_HINT, ceiling - scanWindow))
    await logRun(startedAt, startedMs, ok, rowsFound, rowsWritten, rowsSkipped, errorMsg, cursorBefore, cursorAfter, extra)
    // Resolve buyers/sellers + any new edition mappings via the existing chain.
    await fireNextPipelineStep("/api/pinnacle/resolve-buyers", true)
  }

  return NextResponse.json(
    {
      ok,
      pipeline: PIPELINE_NAME,
      found: rowsFound,
      sales_written: rowsWritten,
      duped: rowsSkipped,
      below_floor: belowFloor,
      next_ceiling: Math.max(SPORK_FLOOR_HINT, ceiling - scanWindow),
      error: errorMsg,
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
