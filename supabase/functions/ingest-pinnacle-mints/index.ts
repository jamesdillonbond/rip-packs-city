// ingest-pinnacle-mints — capture Disney Pinnacle primary mints (pack-pull / airdrop /
// primary-purchase, which are INDISTINGUISHABLE on-chain) into pinnacle_mint_events.
//
// On-chain shape (verified 2026-07-13 by decoding live Pinnacle mint txs via Flow REST):
//   Every primary acquisition is an Admin `mintNFT` on A.edf9df96c92f4595.Pinnacle
//   (authorizer = the contract account). Each mint fires, in the SAME tx:
//     • A.edf9df96c92f4595.Pinnacle.PinNFTMinted { id, renderID, editionID, serialNumber?, maturityDate? }
//     • A.edf9df96c92f4595.Pinnacle.Deposit      { id, to }   ← recipient wallet
//   There is NO PackNFT reveal/burn event and NO user-signed pack-open, so we cannot
//   prove pack-pull vs airdrop; downstream we label these 'mint' (honest), not 'pack_pull'.
//
//   PinNFTMinted is the mint marker; correlating (tx_id, nft_id) → Deposit.to gives the
//   recipient. A transfer/sale Deposit has NO PinNFTMinted for that id in its tx, so this
//   join automatically excludes transfers.
//
// Two modes via ?mode=  (default forward):
//   forward  — walk UP from the forward cursor toward the sealed tip (new mints).
//   backfill — walk DOWN from the backfill cursor toward the current-spork floor
//              (137390146; Flow REST 404s below it — pre-spork mints need the spork worker).
//
// Gated by ?key=; verify_jwt=false. Self-logs to pipeline_runs. Flow REST is reachable
// directly from Supabase edge egress for Pinnacle events (proven by the live
// pinnacle-owner-discovery-forward fn) — no proxy needed for /v1/events reads.

import { createClient } from "@supabase/supabase-js"

// Cron gate key is a Supabase edge SECRET, never hardcoded (this repo is PUBLIC).
// Fail CLOSED when unset: the guard below rejects every request rather than
// accepting an empty ?key=. Rotate with:
//   supabase secrets set PINNACLE_MINTS_GATE_KEY=<new-random>
const GATE = Deno.env.get("PINNACLE_MINTS_GATE_KEY") ?? ""

const FLOW_REST = "https://rest-mainnet.onflow.org"
const MINTED_EVENT = "A.edf9df96c92f4595.Pinnacle.PinNFTMinted"
const DEPOSIT_EVENT = "A.edf9df96c92f4595.Pinnacle.Deposit"
const CHUNK_SIZE = 250
const MAX_BLOCKS_PER_RUN = 5000
const SAFETY_LAG_BLOCKS = 100
const SPORK_FLOOR = 137390146 // below this, public Flow REST 404s (spork-pruned)
const INTER_CHUNK_DELAY_MS = 80
const PIN_COLLECTION_ID = "7dd9dd11-e8b6-45c4-ac99-71331f959714"

const CURSOR_FORWARD = "pinnacle-mint-scan-forward"
const CURSOR_BACKFILL = "pinnacle-mint-scan-backfill"

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

async function fetchEvents(eventType: string, start: number, end: number): Promise<FlowEventBlock[]> {
  const url = `${FLOW_REST}/v1/events?type=${encodeURIComponent(eventType)}&start_height=${start}&end_height=${end}`
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) })
  if (!res.ok) {
    // THROW (don't return []) on a transient Flow REST error. Returning [] is
    // indistinguishable from a genuinely empty window, so the caller advances the
    // cursor past this range and it is never re-scanned → silent, permanent loss of
    // any PinNFTMinted/Deposit in it. Throwing propagates to the Deno.serve catch,
    // which logs ok:false and HOLDS the cursor for a retry next tick (matches
    // getSealedHeight() and the sibling pack-opens ingesters).
    throw new Error(`events ${eventType.split(".").pop()} ${start}-${end} HTTP ${res.status}`)
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

interface MintInfo { renderId: string | null; editionId: number | null; mintedAt: string; blockHeight: number }

function extractMint(payloadBase64: string): { nftId: string; renderId: string | null; editionId: number | null } | null {
  try {
    const raw = JSON.parse(atob(payloadBase64))
    const u = unwrapCdc(raw) as Record<string, unknown>
    const id = u?.id
    if (id === undefined || id === null) return null
    const nftId = String(id)
    if (!nftId) return null
    const renderRaw = u?.renderID
    const editionRaw = u?.editionID
    const renderId = renderRaw === undefined || renderRaw === null ? null : String(renderRaw)
    const editionId = editionRaw === undefined || editionRaw === null ? null : Number(editionRaw)
    return { nftId, renderId, editionId: Number.isFinite(editionId as number) ? (editionId as number) : null }
  } catch (err) {
    console.log(`[ingest-pinnacle-mints] mint decode err: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

function extractDeposit(payloadBase64: string): { nftId: string; to: string } | null {
  try {
    const raw = JSON.parse(atob(payloadBase64))
    const u = unwrapCdc(raw) as Record<string, unknown>
    const id = u?.id
    const to = u?.to
    if (id === undefined || id === null || to === undefined || to === null) return null
    const nftId = String(id)
    const toAddr = String(to).toLowerCase()
    if (!nftId || !toAddr.startsWith("0x")) return null
    return { nftId, to: toAddr }
  } catch (err) {
    console.log(`[ingest-pinnacle-mints] deposit decode err: ${err instanceof Error ? err.message : String(err)}`)
    return null
  }
}

async function logPipelineRun(args: {
  pipeline: string; startedAt: string; rowsFound: number; rowsWritten: number; rowsSkipped: number
  ok: boolean; error?: string | null; cursorBefore?: string | null; cursorAfter?: string | null
  extra?: Record<string, unknown>
}): Promise<void> {
  try {
    // deno-lint-ignore no-explicit-any
    await (supabase as any).rpc("log_pipeline_run", {
      p_pipeline: args.pipeline,
      p_started_at: args.startedAt, p_rows_found: args.rowsFound,
      p_rows_written: args.rowsWritten, p_rows_skipped: args.rowsSkipped,
      p_ok: args.ok, p_error: args.error ?? null,
      p_collection_slug: "disney-pinnacle",
      p_cursor_before: args.cursorBefore ?? null, p_cursor_after: args.cursorAfter ?? null,
      p_extra: args.extra ?? null,
    })
  } catch (e) {
    console.log(`[ingest-pinnacle-mints] log err: ${e instanceof Error ? e.message : String(e)}`)
  }
}

// Scan [windowStart, windowEnd] in CHUNK_SIZE sub-ranges; correlate PinNFTMinted → Deposit.to
// and upsert mint rows. Returns counts.
async function scanWindow(windowStart: number, windowEnd: number): Promise<{ found: number; written: number; skipped: number }> {
  let eventsFound = 0
  let inserted = 0
  let skipped = 0

  for (let chunkStart = windowStart; chunkStart <= windowEnd; chunkStart += CHUNK_SIZE) {
    const chunkEnd = Math.min(chunkStart + CHUNK_SIZE - 1, windowEnd)

    const [mintBlocks, depositBlocks] = await Promise.all([
      fetchEvents(MINTED_EVENT, chunkStart, chunkEnd),
      fetchEvents(DEPOSIT_EVENT, chunkStart, chunkEnd),
    ])

    // Build mint map keyed by `${tx}_${nftId}`.
    const mintMap = new Map<string, MintInfo & { nftId: string }>()
    for (const blk of mintBlocks) {
      const bh = Number(blk.block_height)
      const ts = blk.block_timestamp
      for (const evt of blk.events ?? []) {
        const parsed = extractMint(evt.payload)
        if (!parsed) continue
        eventsFound++
        mintMap.set(`${evt.transaction_id}_${parsed.nftId}`, {
          nftId: parsed.nftId, renderId: parsed.renderId, editionId: parsed.editionId,
          mintedAt: ts, blockHeight: bh,
        })
      }
    }

    if (mintMap.size === 0) {
      if (chunkEnd < windowEnd) await sleep(INTER_CHUNK_DELAY_MS)
      continue
    }

    // Correlate to same-tx Deposit for the recipient.
    const rows = new Map<string, {
      nft_id: string; to_wallet: string; tx_hash: string; block_height: number
      render_id: string | null; edition_id: number | null; minted_at: string
    }>()
    for (const blk of depositBlocks) {
      for (const evt of blk.events ?? []) {
        const dep = extractDeposit(evt.payload)
        if (!dep) continue
        const mint = mintMap.get(`${evt.transaction_id}_${dep.nftId}`)
        if (!mint) continue // Deposit without a same-tx mint for this id → transfer, skip.
        rows.set(dep.nftId, {
          nft_id: dep.nftId, to_wallet: dep.to, tx_hash: evt.transaction_id,
          block_height: mint.blockHeight, render_id: mint.renderId,
          edition_id: mint.editionId, minted_at: mint.mintedAt,
        })
      }
    }

    const batch = Array.from(rows.values())
    for (let i = 0; i < batch.length; i += 200) {
      const slice = batch.slice(i, i + 200)
      const { error } = await supabase
        .from("pinnacle_mint_events")
        .upsert(slice, { onConflict: "nft_id", ignoreDuplicates: true })
      if (error) {
        console.log(`[ingest-pinnacle-mints] upsert err: ${error.message}`)
        skipped += slice.length
      } else {
        inserted += slice.length
      }
    }

    if (chunkEnd < windowEnd) await sleep(INTER_CHUNK_DELAY_MS)
  }

  return { found: eventsFound, written: inserted, skipped }
}

async function readCursor(id: string): Promise<{ h: number; found: number; ins: number; skip: number }> {
  const { data } = await supabase
    .from("flow_backfill_progress")
    .select("last_processed_height, total_events_found, total_inserted, total_skipped")
    .eq("id", id)
    .maybeSingle()
  return {
    h: Number(data?.last_processed_height ?? 0),
    found: Number(data?.total_events_found ?? 0),
    ins: Number(data?.total_inserted ?? 0),
    skip: Number(data?.total_skipped ?? 0),
  }
}

async function saveCursor(id: string, h: number, addFound: number, addIns: number, addSkip: number, prev: { found: number; ins: number; skip: number }): Promise<void> {
  const { error } = await supabase
    .from("flow_backfill_progress")
    .update({
      last_processed_height: h,
      total_events_found: prev.found + addFound,
      total_inserted: prev.ins + addIns,
      total_skipped: prev.skip + addSkip,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id)
  if (error) console.log(`[ingest-pinnacle-mints] save cursor ${id} err: ${error.message}`)
}

async function runForward(startedAtIso: string, started: number) {
  const pipeline = "ingest-pinnacle-mints-forward"
  const cur = await readCursor(CURSOR_FORWARD)
  const sealed = await getSealedHeight()
  const safeTip = sealed - SAFETY_LAG_BLOCKS
  let cursor = cur.h
  if (cursor <= 0) cursor = safeTip - 1

  if (cursor >= safeTip) {
    await logPipelineRun({
      pipeline, startedAt: startedAtIso, rowsFound: 0, rowsWritten: 0, rowsSkipped: 0, ok: true,
      cursorBefore: String(cursor), cursorAfter: String(cursor),
      extra: { message: "already at tip", sealed_height: sealed, elapsed_ms: Date.now() - started },
    })
    return
  }

  const windowStart = cursor + 1
  const windowEnd = Math.min(safeTip, windowStart + MAX_BLOCKS_PER_RUN - 1)
  console.log(`[ingest-pinnacle-mints] forward ${windowStart} → ${windowEnd}`)
  const r = await scanWindow(windowStart, windowEnd)
  await saveCursor(CURSOR_FORWARD, windowEnd, r.found, r.written, r.skipped, cur)
  await logPipelineRun({
    pipeline, startedAt: startedAtIso, rowsFound: r.found, rowsWritten: r.written, rowsSkipped: r.skipped, ok: true,
    cursorBefore: String(cursor), cursorAfter: String(windowEnd),
    extra: { mode: "forward", window_start: windowStart, window_end: windowEnd, sealed_height: sealed, elapsed_ms: Date.now() - started },
  })
}

async function runBackfill(startedAtIso: string, started: number) {
  const pipeline = "ingest-pinnacle-mints-backfill"
  const cur = await readCursor(CURSOR_BACKFILL)
  const sealed = await getSealedHeight()
  let cursor = cur.h
  if (cursor <= 0) cursor = sealed - SAFETY_LAG_BLOCKS

  if (cursor <= SPORK_FLOOR) {
    await logPipelineRun({
      pipeline, startedAt: startedAtIso, rowsFound: 0, rowsWritten: 0, rowsSkipped: 0, ok: true,
      cursorBefore: String(cursor), cursorAfter: String(cursor),
      extra: { message: "reached spork floor — pre-spork mints need the spork worker", spork_floor: SPORK_FLOOR, elapsed_ms: Date.now() - started },
    })
    return
  }

  const windowEnd = cursor - 1
  const windowStart = Math.max(SPORK_FLOOR, windowEnd - MAX_BLOCKS_PER_RUN + 1)
  console.log(`[ingest-pinnacle-mints] backfill ${windowStart} → ${windowEnd}`)
  const r = await scanWindow(windowStart, windowEnd)
  await saveCursor(CURSOR_BACKFILL, windowStart, r.found, r.written, r.skipped, cur)
  await logPipelineRun({
    pipeline, startedAt: startedAtIso, rowsFound: r.found, rowsWritten: r.written, rowsSkipped: r.skipped, ok: true,
    cursorBefore: String(cursor), cursorAfter: String(windowStart),
    extra: { mode: "backfill", window_start: windowStart, window_end: windowEnd, spork_floor: SPORK_FLOOR, elapsed_ms: Date.now() - started },
  })
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url)
  if (!GATE || url.searchParams.get("key") !== GATE) {
    return new Response(JSON.stringify({ error: "forbidden" }), { status: 403, headers: { "content-type": "application/json" } })
  }
  const mode = (url.searchParams.get("mode") ?? "forward").toLowerCase()
  const started = Date.now()
  const startedAtIso = new Date(started).toISOString()

  // Run the scan INSIDE the request. A single window (~5000 blocks / ~40s) finishes
  // well under the edge-fn wall limit, and pg_net (the pg_cron trigger) is async so it
  // doesn't block on the duration. We deliberately do NOT use EdgeRuntime.waitUntil:
  // background work after an early response is torn down here (observed: 200ms runs that
  // never scanned), whereas awaiting matches the reliable sibling pack-open ingesters.
  try {
    if (mode === "backfill") await runBackfill(startedAtIso, started)
    else await runForward(startedAtIso, started)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.log(`[ingest-pinnacle-mints] fatal (${mode}): ${msg}`)
    await logPipelineRun({
      pipeline: `ingest-pinnacle-mints-${mode === "backfill" ? "backfill" : "forward"}`,
      startedAt: startedAtIso, rowsFound: 0, rowsWritten: 0, rowsSkipped: 0, ok: false, error: msg,
      extra: { elapsed_ms: Date.now() - started },
    })
    return new Response(JSON.stringify({ ok: false, mode, error: msg }), {
      status: 500, headers: { "Content-Type": "application/json" },
    })
  }

  return new Response(
    JSON.stringify({ ok: true, mode, started_at: startedAtIso, elapsed_ms: Date.now() - started, collection: PIN_COLLECTION_ID }),
    { headers: { "Content-Type": "application/json" } },
  )
})
