import { NextRequest, NextResponse, after } from "next/server"
import {
  parseOfferCompletedFill,
  buildOfferFillSales,
  insertOfferFillSales,
  stampOfferFillTxHashes,
  type OfferFillEvent,
} from "@/lib/chains/flow/topshot-offer-fill"
import { supabaseAdmin } from "@/lib/supabase"

// ── Backfill: recover accepted-offer sales (the OffersV2 fill gap) ────────────
//
// The topshot-offers-indexer began ~2026-06-03; the ~6,869 offers it already
// flipped to status='filled' were never written to `sales` (offers.tx_hash is
// the OfferAvailable creation tx, not the OfferCompleted fill tx). This route
// re-walks OfferCompleted (purchased=true, TopShot) over the historical range
// and writes a source='offer_fill' sale per event — exactly the same builder the
// forward indexer uses. Idempotent via the sales transaction_hash unique index,
// so it's safe to re-run and safe to overlap the live indexer.
//
// Drains a bounded block range per call behind its own event_cursor; wire a
// low-cadence cron until the cursor reaches the current frontier, then it no-ops.
//
// POST /api/admin/backfill-offer-fill-sales  Bearer $INGEST_SECRET_TOKEN
//   ?start_block=N  (one-time override of the cursor start)
//   ?range=N        (max blocks this invocation; default 80000, cap 300000)
//   ?sync=1         (run the drain synchronously and return its result — used by
//                    the GHA workflow, which has no 30s client cap; the default
//                    202+after() path is unreliable for a ~235s tail on Vercel)
// ─────────────────────────────────────────────────────────────────────────────

export const maxDuration = 300
export const dynamic = "force-dynamic"

const TOKEN = process.env.INGEST_SECRET_TOKEN ?? ""
const PIPELINE_NAME = "backfill-offer-fill-sales"
const CURSOR_ID = "topshot_offer_fill_backfill"

const OFFER_COMPLETED = "A.b8ea91944fd51c43.OffersV2.OfferCompleted"
const FLOW_REST = "https://rest-mainnet.onflow.org"
const CHUNK_SIZE = 250
// Per-call work is kept small so a SYNCHRONOUS response always returns well under
// maxDuration=300: the chunk-scan is time-bounded by BUDGET_MS, but the
// post-scan stamp loop (one UPDATE per filled offer) is NOT — denser recent
// ranges make it the long pole. A 20k-block range caps the fill count (≈ a few
// hundred) so scan + build + stamp finish in ~60-120s. The GHA workflow LOOPS
// these bounded calls to catch up, so a small range doesn't slow the drain.
const DEFAULT_RANGE = 20_000
const RANGE_CAP = 300_000
const INTER_CHUNK_DELAY_MS = 60
const BUDGET_MS = 150_000
// ~block at the earliest TS offer (2026-06-03 22:44, ~block 153.65M); start a bit
// before so no historical fill is missed.
const DEFAULT_START = 153_600_000

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
}
function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

// Minimal JSON-CDC unwrapper (mirror of the offers indexer).
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
  block_height: string
  block_timestamp: string
  events?: Array<{ type: string; transaction_id: string; payload: string; event_index: number }>
}

async function fetchCompletedRange(start: number, end: number): Promise<FlowEventBlock[]> {
  const url = `${FLOW_REST}/v1/events?type=${encodeURIComponent(OFFER_COMPLETED)}&start_height=${start}&end_height=${end}`
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) })
  if (!res.ok) {
    console.log(`[${PIPELINE_NAME}] events ${start}-${end} HTTP ${res.status}`)
    return []
  }
  const json = (await res.json()) as FlowEventBlock[]
  return Array.isArray(json) ? json : []
}

async function getLatestSealedHeight(): Promise<number> {
  const res = await fetch(`${FLOW_REST}/v1/blocks?height=sealed`, { signal: AbortSignal.timeout(8000) })
  if (!res.ok) throw new Error(`blocks sealed HTTP ${res.status}`)
  const json = (await res.json()) as Array<{ header: { height: string } }>
  return Number(json[0]?.header?.height ?? 0)
}

export async function POST(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? ""
  const bearer = auth.replace(/^Bearer\s+/i, "")
  const urlToken = req.nextUrl.searchParams.get("token") ?? ""
  if (!TOKEN || (bearer !== TOKEN && urlToken !== TOKEN)) return unauthorized()

  const rangeParam = Number(req.nextUrl.searchParams.get("range") ?? DEFAULT_RANGE)
  const maxRange = Math.min(Math.max(rangeParam || DEFAULT_RANGE, CHUNK_SIZE), RANGE_CAP)
  const startBlockOverride = req.nextUrl.searchParams.get("start_block")

  // Synchronous path (GHA, curl --max-time 600). The drain runs to BUDGET_MS
  // (235s) inside maxDuration=300 and the result is returned in the body — no
  // dropped after() tail. log_pipeline_run still fires at the end of drain().
  const sync =
    req.nextUrl.searchParams.get("sync") === "1" ||
    req.nextUrl.searchParams.get("wait") === "1"
  if (sync) {
    const result = await drain(maxRange, startBlockOverride)
    return NextResponse.json(result, { status: 200 })
  }

  // Legacy fire-and-forget path (cron-job.org's 30s client cap). Unreliable for
  // the ~235s tail on Vercel — superseded by the GHA sync path above.
  after(() => drain(maxRange, startBlockOverride))
  return NextResponse.json({ status: "accepted" }, { status: 202 })
}

// Bounded historical drain: re-walk OfferCompleted over one block range, write the
// offer_fill sales, AND stamp offers.fill_tx_hash for provenance (the forward
// indexer only stamps go-forward fills, so the historical backlog is stamped here).
async function drain(maxRange: number, startBlockOverride: string | null) {
  const startTime = Date.now()

  let cursorBefore: string | null = null
  let cursorAfter: string | null = null
  let pages = 0
  let fillsSeen = 0
  let salesWritten = 0
  let salesDuped = 0
  let salesUnresolved = 0
  let offersStamped = 0
  let fetchError: string | null = null
  let done = false

  try {
    const { data: cursorRow } = await (supabaseAdmin as any)
      .from("event_cursor")
      .select("last_processed_block")
      .eq("id", CURSOR_ID)
      .maybeSingle()

    let lastBlock = Number(cursorRow?.last_processed_block ?? 0)
    if (startBlockOverride != null && startBlockOverride !== "") {
      lastBlock = Math.max(Number(startBlockOverride) - 1, 0)
    } else if (lastBlock === 0) {
      lastBlock = DEFAULT_START - 1
    }
    cursorBefore = String(lastBlock)

    const currentHeight = await getLatestSealedHeight()
    if (lastBlock >= currentHeight) {
      cursorAfter = String(lastBlock)
      await logRun(startTime, true, null, cursorBefore, cursorAfter, { message: "backfill complete", current_height: currentHeight, done: true })
      return {
        ok: true,
        error: null,
        cursor_before: cursorBefore,
        cursor_after: cursorAfter,
        message: "backfill complete",
        current_height: currentHeight,
        done: true,
      }
    }

    const targetHeight = Math.min(lastBlock + maxRange, currentHeight)
    const fills: OfferFillEvent[] = []
    let processedTo = lastBlock

    for (let s = lastBlock + 1; s <= targetHeight; s += CHUNK_SIZE) {
      const e = Math.min(s + CHUNK_SIZE - 1, targetHeight)
      const blocks = await fetchCompletedRange(s, e)
      pages++
      for (const blk of blocks) {
        for (const evt of blk.events ?? []) {
          try {
            const payload = unwrapCdc(JSON.parse(Buffer.from(evt.payload, "base64").toString("utf8"))) as Record<string, any>
            const fill = parseOfferCompletedFill(payload, evt.transaction_id, blk.block_timestamp, Number(blk.block_height) || null)
            if (fill) fills.push(fill)
          } catch { /* skip malformed */ }
        }
      }
      processedTo = e
      if (Date.now() - startTime > BUDGET_MS) break
      if (e < targetHeight) await delay(INTER_CHUNK_DELAY_MS)
    }

    fillsSeen = fills.length
    if (fills.length > 0) {
      const built = await buildOfferFillSales(fills)
      salesUnresolved = built.unresolved
      const ins = await insertOfferFillSales(built.rows)
      salesWritten = ins.inserted
      salesDuped = ins.duped
      // close the provenance gap: stamp fill_tx_hash on the matching offer rows
      const stamp = await stampOfferFillTxHashes(fills)
      offersStamped = stamp.stamped
    }

    await (supabaseAdmin as any)
      .from("event_cursor")
      .upsert({ id: CURSOR_ID, last_processed_block: processedTo, updated_at: new Date().toISOString() }, { onConflict: "id" })
    cursorAfter = String(processedTo)
    done = processedTo >= currentHeight
  } catch (err) {
    fetchError = err instanceof Error ? err.message : String(err)
    console.log(`[${PIPELINE_NAME}] error:`, fetchError)
  }

  const extra = {
    pages,
    fills_seen: fillsSeen,
    sales_written: salesWritten,
    sales_duped: salesDuped,
    sales_unresolved: salesUnresolved,
    offers_stamped: offersStamped,
    done,
    duration_ms: Date.now() - startTime,
  }
  await logRun(startTime, fetchError === null, fetchError, cursorBefore, cursorAfter, extra)

  return {
    ok: fetchError === null,
    error: fetchError,
    cursor_before: cursorBefore,
    cursor_after: cursorAfter,
    ...extra,
  }
}

async function logRun(
  startTime: number,
  ok: boolean,
  error: string | null,
  cursorBefore: string | null,
  cursorAfter: string | null,
  extra: Record<string, unknown>,
) {
  try {
    await (supabaseAdmin as any).rpc("log_pipeline_run", {
      p_pipeline: PIPELINE_NAME,
      p_started_at: new Date(startTime).toISOString(),
      p_rows_found: Number(extra.fills_seen ?? 0),
      p_rows_written: Number(extra.sales_written ?? 0),
      p_rows_skipped: Number(extra.sales_duped ?? 0) + Number(extra.sales_unresolved ?? 0),
      p_ok: ok,
      p_error: error,
      p_collection_slug: "nba_top_shot",
      p_cursor_before: cursorBefore,
      p_cursor_after: cursorAfter,
      p_extra: extra,
    })
  } catch (e) {
    console.log(`[${PIPELINE_NAME}] log_pipeline_run failed (non-fatal):`, e instanceof Error ? e.message : String(e))
  }
}

export async function GET() {
  const { data } = await (supabaseAdmin as any)
    .from("event_cursor")
    .select("last_processed_block, updated_at")
    .eq("id", CURSOR_ID)
    .maybeSingle()
  return NextResponse.json({
    ok: true,
    note: "POST with Bearer INGEST_SECRET_TOKEN to drain the offer-fill sale backfill",
    cursor: data ?? null,
    defaultStart: DEFAULT_START,
  })
}
