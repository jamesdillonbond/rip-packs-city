// pinnacle-owner-discovery-forward v2 — fire-and-forget background work.
//
// v1 ran the full scan synchronously inside the request handler. With
// MAX_BLOCKS_PER_RUN=5000, that's ~20 chunks x ~1.6s each = ~32s, which
// exceeds cron-job.org's 30s timeout and produced a 503 on the test run.
//
// v2 returns a 200 immediately after auth + cursor read, kicks the actual
// scan into the background via EdgeRuntime.waitUntil. Same pattern as the
// other long-running pipelines (compute-allday-pack-ev, compute-topshot-pack-ev).
// Real progress shows up in pipeline_runs within ~30-60s after the response.
//
// Same scan logic, same scoring, same cursor management as v1.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0"

const INGEST_SECRET_TOKEN = Deno.env.get("INGEST_SECRET_TOKEN")
if (!INGEST_SECRET_TOKEN) throw new Error("INGEST_SECRET_TOKEN env var is required")

const FLOW_REST = "https://rest-mainnet.onflow.org"
const DEPOSIT_EVENT = "A.edf9df96c92f4595.Pinnacle.Deposit"
const CHUNK_SIZE = 250
const MAX_BLOCKS_PER_RUN = 5000
const SAFETY_LAG_BLOCKS = 100
const INTER_CHUNK_DELAY_MS = 80
const SCAN_STATE_ID = "pinnacle-deposit-scan-forward"

const supabase = createClient(
  Deno.env.get("SUPABASE_URL") ?? "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
)

function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)) }

function unwrapCdc(node: unknown): unknown {
  if (node === null || node === undefined) return node
  if (Array.isArray(node)) return node.map(unwrapCdc)
  if (typeof node !== "object") return node
  const { type, value } = node as { type?: string; value?: unknown }
  if (type !== undefined && value !== undefined) {
    switch (type) {
      case "Optional": return value === null ? null : unwrapCdc(value)
      case "Array": return (value as unknown[]).map(unwrapCdc)
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
      case "Type": return { staticType: (value as { staticType?: unknown }).staticType }
      default: return value
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

async function fetchDepositEvents(start: number, end: number): Promise<FlowEventBlock[]> {
  const url = `${FLOW_REST}/v1/events?type=${encodeURIComponent(DEPOSIT_EVENT)}&start_height=${start}&end_height=${end}`
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) })
  if (!res.ok) {
    console.log(`[pinnacle-owner-discovery-forward] events ${start}-${end} HTTP ${res.status}`)
    return []
  }
  const json = (await res.json()) as FlowEventBlock[]
  return Array.isArray(json) ? json : []
}

async function getSealedHeight(): Promise<number> {
  const res = await fetch(`${FLOW_REST}/v1/blocks?height=sealed`, { signal: AbortSignal.timeout(8000) })
  if (!res.ok) throw new Error(`blocks sealed HTTP ${res.status}`)
  const json = (await res.json()) as Array<{ header: { height: string } }>
  return Number(json[0]?.header?.height ?? 0)
}

function extractDeposit(payloadBase64: string): { nftId: string; to: string } | null {
  try {
    const raw = JSON.parse(atob(payloadBase64))
    const unwrapped = unwrapCdc(raw) as Record<string, unknown>
    const idField = unwrapped?.id
    const toField = unwrapped?.to
    if (idField === undefined || idField === null) return null
    if (toField === undefined || toField === null) return null
    const nftId = String(idField)
    const to = String(toField).toLowerCase()
    if (!nftId || !to.startsWith("0x")) return null
    return { nftId, to }
  } catch (err) {
    console.log(`[pinnacle-owner-discovery-forward] decode err: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

async function logPipelineRun(args: {
  startedAt: string; rowsFound: number; rowsWritten: number; rowsSkipped: number
  ok: boolean; error?: string | null
  cursorBefore?: string | null; cursorAfter?: string | null
  extra?: Record<string, unknown>
}): Promise<void> {
  try {
    // deno-lint-ignore no-explicit-any
    await (supabase as any).rpc("log_pipeline_run", {
      p_pipeline: "pinnacle-owner-discovery-forward",
      p_started_at: args.startedAt, p_rows_found: args.rowsFound,
      p_rows_written: args.rowsWritten, p_rows_skipped: args.rowsSkipped,
      p_ok: args.ok, p_error: args.error ?? null,
      p_collection_slug: "disney-pinnacle",
      p_cursor_before: args.cursorBefore ?? null, p_cursor_after: args.cursorAfter ?? null,
      p_extra: args.extra ?? null,
    })
  } catch (e) {
    console.log(`[pinnacle-owner-discovery-forward] log err: ${e instanceof Error ? e.message : String(e)}`)
  }
}

async function runBackgroundScan(startedAtIso: string, started: number) {
  try {
    const { data: stateRow, error: stateErr } = await supabase
      .from("flow_backfill_progress")
      .select("last_processed_height, total_events_found, total_inserted, total_skipped")
      .eq("id", SCAN_STATE_ID)
      .maybeSingle()
    if (stateErr) throw new Error(`load state: ${stateErr.message}`)
    const totalEventsFound = Number(stateRow?.total_events_found ?? 0)
    const totalInserted = Number(stateRow?.total_inserted ?? 0)
    const totalSkipped = Number(stateRow?.total_skipped ?? 0)
    let lastProcessed = Number(stateRow?.last_processed_height ?? 0)

    const sealedHeight = await getSealedHeight()
    const safeTip = sealedHeight - SAFETY_LAG_BLOCKS

    if (lastProcessed <= 0) {
      lastProcessed = safeTip - 1
      console.log(`[pinnacle-owner-discovery-forward] first-run seed: cursor=${lastProcessed}`)
    }

    if (lastProcessed >= safeTip) {
      await logPipelineRun({
        startedAt: startedAtIso, rowsFound: 0, rowsWritten: 0, rowsSkipped: 0,
        ok: true, cursorBefore: String(lastProcessed), cursorAfter: String(lastProcessed),
        extra: {
          message: "already at tip", sealed_height: sealedHeight, safe_tip: safeTip,
          elapsed_ms: Date.now() - started, function_version: 2,
        },
      })
      return
    }

    const windowStart = lastProcessed + 1
    const windowEnd = Math.min(safeTip, windowStart + MAX_BLOCKS_PER_RUN - 1)

    console.log(`[pinnacle-owner-discovery-forward] scanning ${windowStart} → ${windowEnd} (${windowEnd - windowStart + 1} blocks)`)

    let eventsFound = 0
    let inserted = 0
    let skipped = 0
    let lastChunkEndCompleted = lastProcessed

    for (let chunkStart = windowStart; chunkStart <= windowEnd; chunkStart += CHUNK_SIZE) {
      const chunkEnd = Math.min(chunkStart + CHUNK_SIZE - 1, windowEnd)
      let blocks: FlowEventBlock[] = []
      try {
        blocks = await fetchDepositEvents(chunkStart, chunkEnd)
      } catch (err) {
        console.log(`[pinnacle-owner-discovery-forward] chunk ${chunkStart}-${chunkEnd} err: ${err instanceof Error ? err.message : String(err)}`)
        break
      }

      const rows: Array<{ nft_id: string; owner: string; deposit_block_height: number }> = []
      for (const blk of blocks) {
        const bh = Number(blk.block_height)
        for (const evt of blk.events ?? []) {
          const parsed = extractDeposit(evt.payload)
          if (!parsed) continue
          eventsFound++
          rows.push({ nft_id: parsed.nftId, owner: parsed.to, deposit_block_height: bh })
        }
      }

      rows.sort((a, b) => a.deposit_block_height - b.deposit_block_height)
      const latest = new Map<string, typeof rows[number]>()
      for (const r of rows) latest.set(r.nft_id, r)
      const dedup = Array.from(latest.values())

      if (dedup.length > 0) {
        for (let i = 0; i < dedup.length; i += 200) {
          const batch = dedup.slice(i, i + 200)
          const { error } = await supabase
            .from("pinnacle_ownership_snapshots")
            .upsert(batch, { onConflict: "nft_id" })
          if (error) {
            console.log(`[pinnacle-owner-discovery-forward] upsert err: ${error.message}`)
            skipped += batch.length
          } else {
            inserted += batch.length
          }
        }
      }

      lastChunkEndCompleted = chunkEnd
      if (chunkEnd < windowEnd) await sleep(INTER_CHUNK_DELAY_MS)
    }

    const nextCursor = lastChunkEndCompleted

    const { error: saveErr } = await supabase
      .from("flow_backfill_progress")
      .update({
        last_processed_height: nextCursor,
        total_events_found: totalEventsFound + eventsFound,
        total_inserted: totalInserted + inserted,
        total_skipped: totalSkipped + skipped,
        updated_at: new Date().toISOString(),
      })
      .eq("id", SCAN_STATE_ID)
    if (saveErr) console.log(`[pinnacle-owner-discovery-forward] save err: ${saveErr.message}`)

    const elapsed = Date.now() - started
    await logPipelineRun({
      startedAt: startedAtIso, rowsFound: eventsFound, rowsWritten: inserted, rowsSkipped: skipped,
      ok: true, cursorBefore: String(lastProcessed), cursorAfter: String(nextCursor),
      extra: {
        window_start: windowStart, window_end: windowEnd,
        sealed_height: sealedHeight, blocks_scanned: nextCursor - lastProcessed,
        elapsed_ms: elapsed, function_version: 2,
      },
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.log(`[pinnacle-owner-discovery-forward] bg fatal: ${msg}`)
    await logPipelineRun({
      startedAt: startedAtIso, rowsFound: 0, rowsWritten: 0, rowsSkipped: 0,
      ok: false, error: msg,
      extra: { elapsed_ms: Date.now() - started, function_version: 2 },
    })
  }
}

Deno.serve(async (req: Request) => {
  const auth = req.headers.get("Authorization") ?? ""
  if (auth !== `Bearer ${INGEST_SECRET_TOKEN}`) return new Response("Unauthorized", { status: 401 })

  const started = Date.now()
  const startedAtIso = new Date(started).toISOString()

  // deno-lint-ignore no-explicit-any
  const edgeRuntime = (globalThis as any).EdgeRuntime
  const workPromise = runBackgroundScan(startedAtIso, started)
  if (edgeRuntime && typeof edgeRuntime.waitUntil === "function") {
    edgeRuntime.waitUntil(workPromise)
  } else {
    workPromise.catch((e) =>
      console.log(`waitUntil fallback err: ${e instanceof Error ? e.message : String(e)}`)
    )
  }

  return new Response(
    JSON.stringify({
      ok: true,
      message: "queued",
      started_at: startedAtIso,
      note: "Scan running in background. Real results appear in pipeline_runs within ~30-60s.",
    }),
    { headers: { "Content-Type": "application/json" } },
  )
})
