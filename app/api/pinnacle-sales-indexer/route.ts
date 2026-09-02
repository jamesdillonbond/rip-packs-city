import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { fireNextPipelineStep } from "@/lib/pipeline-chain"

// ── On-chain Disney Pinnacle sales indexer ───────────────────────────────────
// Scans NFTStorefrontV2.ListingCompleted, filters to Pinnacle NFT purchases,
// resolves nftID → edition_key via pinnacle_nft_map / wallet_moments_cache,
// and writes dedup'd sales into the pinnacle_sales table. Unresolved nft_ids
// are stored with edition_id = null and will backfill as the nft_map grows.
//
// Chains pinnacle-resolve-buyers on every successful run so the buyer/seller
// resolver doesn't depend on a separate cron-job.org schedule that can
// silently die. Pattern mirrors allday-sales-indexer firing
// allday-unmapped-resolver. The chain is unconditional (true) — resolver
// has its own batch limit + idempotency, so triggering with no new sales
// just means an empty drain.

const TOKEN = process.env.INGEST_SECRET_TOKEN ?? ""
const STOREFRONT_EVENT = "A.4eb8a10cb9f87357.NFTStorefrontV2.ListingCompleted"
const PINNACLE_TYPE_MATCH = "Pinnacle"
const FLOW_REST = "https://rest-mainnet.onflow.org"
const CHUNK_SIZE = 250
const MAX_SCAN_RANGE = 2_000
const INTER_CHUNK_DELAY_MS = 75
const PIPELINE_NAME = "pinnacle-sales-indexer"
const COLLECTION_SLUG = "disney_pinnacle"

// OBSERVABILITY (added 2026-08-01). This route had NO log_pipeline_run call of
// any kind, so a live every-20-min ingest was invisible to pipeline_runs,
// detect_stalled_pipelines() and pipeline_cadence_watchlist. It was demonstrably
// working - 240 pinnacle_sales rows written in the preceding 24h - but that
// could only be proven from the DESTINATION TABLE, and if it silently stopped
// nothing would have paged.
//
// This route is fully SYNCHRONOUS (no after()), so no separate invoked-marker is
// needed: every terminal path below logs exactly once before returning, so the
// absence of a row genuinely means the route was never reached.
async function logPipelineRun(args: {
  startedAtIso: string
  ok: boolean
  rowsFound?: number
  rowsWritten?: number
  rowsSkipped?: number
  errorMsg?: string | null
  cursorBefore?: number | null
  cursorAfter?: number | null
  extra: Record<string, unknown>
}) {
  try {
    const { error } = await (supabaseAdmin as any).rpc("log_pipeline_run", {
      p_pipeline: PIPELINE_NAME,
      p_started_at: args.startedAtIso,
      p_rows_found: args.rowsFound ?? 0,
      p_rows_written: args.rowsWritten ?? 0,
      p_rows_skipped: args.rowsSkipped ?? 0,
      p_ok: args.ok,
      p_error: args.errorMsg ?? null,
      p_collection_slug: COLLECTION_SLUG,
      p_cursor_before: args.cursorBefore != null ? String(args.cursorBefore) : null,
      p_cursor_after: args.cursorAfter != null ? String(args.cursorAfter) : null,
      p_extra: args.extra,
    })
    if (error) console.log(`[${PIPELINE_NAME}] log_pipeline_run:`, error.message)
  } catch (err) {
    console.log(`[${PIPELINE_NAME}] log_pipeline_run threw:`, err instanceof Error ? err.message : err)
  }
}

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
      case "Optional": return value === null ? null : unwrapCdc(value)
      case "Array": return (value as unknown[]).map(unwrapCdc)
      case "Dictionary": {
        const out: Record<string, unknown> = {}
        for (const kv of value as Array<{ key: unknown; value: unknown }>) {
          out[String(unwrapCdc(kv.key))] = unwrapCdc(kv.value)
        }
        return out
      }
      case "Struct": case "Resource": case "Event": case "Contract": case "Enum": {
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

async function fetchEventRange(type: string, start: number, end: number): Promise<FlowEventBlock[]> {
  const url = `${FLOW_REST}/v1/events?type=${encodeURIComponent(type)}&start_height=${start}&end_height=${end}`
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) })
  if (!res.ok) {
    // ⚠ THROW, DO NOT `return []` — see the 7 sibling block-scan indexers
    // (2026-08-21). A non-2xx swallowed into an empty array is delivered to the
    // chunk loop as a range that read fine and was GENUINELY EMPTY, so the
    // cursor advances past blocks nothing read. Nothing revisits a block below
    // the cursor, so those sales are lost permanently under a clean `ok: true`.
    //
    // ⚠ The throw is only half the fix HERE, which is why this route was held
    // back rather than shipped with the other seven. This loop writes the cursor
    // PER CHUNK and its catch does not `break`, so chunk N+1 succeeding would
    // write a cursor past failed chunk N — a leapfrog that happens even on a
    // thrown error. The per-chunk write is now gated on nothing having failed
    // yet; see `firstFailedChunkStart` below.
    throw new Error(`[pinnacle-sales-indexer] events ${start}-${end} HTTP ${res.status}`)
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

async function runIndexer(req: NextRequest) {
  const started = Date.now()
  const startedAtIso = new Date(started).toISOString()

  const auth = req.headers.get("authorization") ?? ""
  const bearer = auth.replace(/^Bearer\s+/i, "")
  const urlToken = req.nextUrl.searchParams.get("token") ?? ""
  if (!TOKEN || (bearer !== TOKEN && urlToken !== TOKEN)) return unauthorized()

  const rangeParam = Number(req.nextUrl.searchParams.get("range") ?? MAX_SCAN_RANGE)
  const maxRange = Math.min(Math.max(rangeParam || MAX_SCAN_RANGE, CHUNK_SIZE), MAX_SCAN_RANGE)

  try {
    const { data: cursorRow, error: cursorErr } = await (supabaseAdmin as any)
      .from("event_cursor")
      .select("last_processed_block")
      .eq("id", "pinnacle_sales")
      .single()
    if (cursorErr) {
      console.log("[pinnacle-sales-indexer] cursor read error:", cursorErr.message)
      await logPipelineRun({
        startedAtIso,
        ok: false,
        errorMsg: `cursor read: ${cursorErr.message}`,
        extra: { phase: "cursor_read_failed" },
      })
      return NextResponse.json({ error: "Failed to read cursor" }, { status: 500 })
    }

    let lastBlock = Number(cursorRow?.last_processed_block ?? 0)
    const currentHeight = await getLatestSealedHeight()
    if (lastBlock >= currentHeight) {
      // Even when there's nothing new to scan, fire the resolver so any
      // residue from prior ticks gets drained on this cron cycle.
      await fireNextPipelineStep("/api/pinnacle/resolve-buyers", true)
      // Logged ok:true - "nothing new on chain" is a healthy tick, and the
      // watchlist keys on SILENCE, so a no-op tick must still be recorded or a
      // quiet chain would look identical to a dead pipeline.
      await logPipelineRun({
        startedAtIso,
        ok: true,
        cursorBefore: lastBlock,
        cursorAfter: lastBlock,
        extra: { phase: "up_to_date", blocks_scanned: 0, chain_height: currentHeight },
      })
      return NextResponse.json({ ok: true, message: "already up to date", cursor: lastBlock, elapsed: Date.now() - started })
    }

    const targetHeight = Math.min(lastBlock + maxRange, currentHeight)
    console.log(`[pinnacle-sales-indexer] scanning ${lastBlock + 1} → ${targetHeight} (${targetHeight - lastBlock} blocks)`)

    interface Sale {
      blockHeight: number
      blockTimestamp: string
      transactionId: string
      nftID: string
      salePrice: string
      commissionReceiver?: string | null
    }

    const sales: Sale[] = []
    let lastChunkEnd = lastBlock
    // Block of the first chunk that failed to fetch, or null when every chunk was
    // read. Once set, the per-chunk cursor write below stops, so a later
    // successful chunk can never leapfrog a failed one.
    let firstFailedChunkStart: number | null = null

    for (let s = lastBlock + 1; s <= targetHeight; s += CHUNK_SIZE) {
      const e = Math.min(s + CHUNK_SIZE - 1, targetHeight)
      try {
        const blocks = await fetchEventRange(STOREFRONT_EVENT, s, e)
        for (const blk of blocks) {
          const bh = Number(blk.block_height)
          const bts = blk.block_timestamp
          for (const evt of blk.events ?? []) {
            try {
              const raw = JSON.parse(Buffer.from(evt.payload, "base64").toString("utf8"))
              const payload = unwrapCdc(raw) as Record<string, any>
              const typeID: string | undefined = payload?.nftType?.staticType?.typeID
              if (!typeID || !typeID.includes(PINNACLE_TYPE_MATCH)) continue
              if (payload.purchased !== true) continue

              sales.push({
                blockHeight: bh,
                blockTimestamp: bts,
                transactionId: evt.transaction_id,
                nftID: String(payload.nftID),
                salePrice: String(payload.salePrice ?? "0"),
                commissionReceiver: payload.commissionReceiver ?? null,
              })
            } catch (err) {
              console.log("[pinnacle-sales-indexer] decode err:", err instanceof Error ? err.message : String(err))
            }
          }
        }
        lastChunkEnd = e
        // Update cursor per chunk so partial progress isn't lost
        const { error: cursorAnchorErr } = await (supabaseAdmin as any)
          .from("event_cursor")
          .update({ last_processed_block: lastChunkEnd, updated_at: new Date().toISOString() })
          .eq("id", "pinnacle_sales")
        // ⚠ A DISCARDED CURSOR-WRITE ERROR TURNS A FAILED ADVANCE INTO A LOGGED
        // MOVEMENT. `cursorAfter` is the only field an operator can read to see the
        // walk progressing, and it was assigned whether or not the write landed — so a
        // tick that could not persist its cursor reported the new block anyway, and the
        // next tick silently re-scanned the identical range. Throw instead: the outer
        // catch marks the run ok:false and leaves `cursorAfter` at its real value.
        if (cursorAnchorErr) throw new Error(`cursor advance failed: ${cursorAnchorErr.message}`)
      } catch (err) {
        console.log(`[pinnacle-sales-indexer] chunk ${s}-${e} error:`, err instanceof Error ? err.message : String(err))
        // ⚠ STOP. This loop writes the cursor PER CHUNK, so without the break a
        // later chunk succeeding writes a cursor ABOVE the failed one — a
        // leapfrog that leaves the failed range permanently below the cursor,
        // where nothing ever returns for it. Same strategy as
        // ufc-sales-indexer: advance per chunk, and stop at the first failure.
        firstFailedChunkStart = s
        break
      }
      if (s + CHUNK_SIZE <= targetHeight) await delay(INTER_CHUNK_DELAY_MS)
    }

    console.log(`[pinnacle-sales-indexer] found ${sales.length} Pinnacle sales`)

    // ⚠ `blocks_scanned` must report what was READ, not the range we intended to
    // read — `targetHeight - lastBlock` on a partial scan is a measured-looking
    // number for blocks nothing fetched.
    const partialScanExtra: Record<string, unknown> =
      firstFailedChunkStart !== null
        ? { partial_scan: true, first_failed_chunk: firstFailedChunkStart, cursor_held_from: targetHeight }
        : {}

    if (sales.length === 0) {
      await fireNextPipelineStep("/api/pinnacle/resolve-buyers", true)
      await logPipelineRun({
        startedAtIso,
        ok: true,
        cursorBefore: lastBlock,
        cursorAfter: lastChunkEnd,
        extra: {
          phase: "no_sales",
          blocks_scanned: lastChunkEnd - lastBlock,
          chain_height: currentHeight,
          elapsed_ms: Date.now() - started,
          ...partialScanExtra,
        },
      })
      return NextResponse.json({
        ok: true, blocksScanned: targetHeight - lastBlock, eventsFound: 0,
        salesInserted: 0, cursor: lastChunkEnd, elapsed: Date.now() - started,
      })
    }

    // Resolve nftID → edition_key. Primary source: pinnacle_nft_map (populated
    // by the regular pinnacle-ingest path). Secondary: wallet_moments_cache.
    // Final fallback: live Flowty lookup of individual NFTs (rate-limited to
    // FLOWTY_LOOKUP_BUDGET per invocation) — on hit, also backfill
    // pinnacle_nft_map so future runs don't need the lookup.
    const uniqueNftIds = [...new Set(sales.map((s) => s.nftID))]
    const nftToEditionId = new Map<string, string>()

    for (let i = 0; i < uniqueNftIds.length; i += 500) {
      const batch = uniqueNftIds.slice(i, i + 500)
      const { data, error: readErr } = await (supabaseAdmin as any)
        .from("pinnacle_nft_map")
        .select("nft_id, edition_key")
        .in("nft_id", batch)
      // ⛔ A FAILED READ HERE IS INDISTINGUISHABLE FROM "nothing matched", AND THE
      // CURSOR ADVANCES EITHER WAY. supabase-js RETURNS its errors, so the `?? []`
      // below published the failure as an empty result and the run moved past this
      // block range for good. Throwing reaches the outer catch, which marks the run
      // ok:false and leaves the cursor where it was, so the range is re-scanned.
      if (readErr) throw new Error(`pinnacle_nft_map read failed: ${readErr.message}`)
      for (const row of data ?? []) {
        if (row.edition_key) nftToEditionId.set(String(row.nft_id), row.edition_key)
      }
    }

    const stillUnresolved = uniqueNftIds.filter((id) => !nftToEditionId.has(id))
    if (stillUnresolved.length > 0) {
      for (let i = 0; i < stillUnresolved.length; i += 500) {
        const batch = stillUnresolved.slice(i, i + 500)
        const { data, error: readErr2 } = await (supabaseAdmin as any)
          .from("wallet_moments_cache")
          .select("moment_id, edition_key")
          .eq("collection_id", "7dd9dd11-e8b6-45c4-ac99-71331f959714")
          .in("moment_id", batch)
        // Same shape as the read above: a failed read must not render as "no match".
        if (readErr2) throw new Error(`wallet_moments_cache read failed: ${readErr2.message}`)
        for (const row of data ?? []) {
          if (row.edition_key) nftToEditionId.set(row.moment_id, row.edition_key)
        }
      }
    }

    const unresolvedCount = uniqueNftIds.filter((id) => !nftToEditionId.has(id)).length
    console.log(
      `[pinnacle-sales-indexer] edition resolution: total=${uniqueNftIds.length} resolved=${nftToEditionId.size} unresolved=${unresolvedCount}`
    )

    const rows = sales.map((s) => ({
      id: `${s.transactionId}_${s.nftID}`,
      edition_id: nftToEditionId.get(s.nftID) ?? null,
      nft_id: s.nftID,
      sale_price_usd: parseFloat(s.salePrice) || 0,
      serial_number: null,
      sold_at: s.blockTimestamp,
      source: "on-chain",
      buyer_address: s.commissionReceiver ?? null,
      seller_address: null,
    }))

    let inserted = 0
    let duped = 0
    for (let i = 0; i < rows.length; i += 100) {
      const batch = rows.slice(i, i + 100)
      const { error } = await (supabaseAdmin as any)
        .from("pinnacle_sales")
        .upsert(batch, { onConflict: "id", ignoreDuplicates: true })
      if (error) {
        if (error.code === "23505") {
          duped += batch.length
        } else {
          console.log("[pinnacle-sales-indexer] batch insert err:", error.message)
          for (const row of batch) {
            const { error: se } = await (supabaseAdmin as any)
              .from("pinnacle_sales")
              .upsert(row, { onConflict: "id", ignoreDuplicates: true })
            if (se) duped++
            else inserted++
          }
        }
      } else {
        inserted += batch.length
      }
    }

    const finalUnresolved = sales.filter((s) => !nftToEditionId.has(s.nftID)).length

    await fireNextPipelineStep("/api/pinnacle/resolve-buyers", true)

    // rows_skipped counts sales the upsert treated as duplicates (already
    // indexed), which is normal on a re-scan and must not read as loss.
    await logPipelineRun({
      startedAtIso,
      ok: true,
      rowsFound: sales.length,
      rowsWritten: inserted,
      rowsSkipped: duped,
      cursorBefore: lastBlock,
      cursorAfter: lastChunkEnd,
      extra: {
        phase: "complete",
        blocks_scanned: lastChunkEnd - lastBlock,
        chain_height: currentHeight,
        ...partialScanExtra,
        unique_nft_ids: uniqueNftIds.length,
        edition_resolved: nftToEditionId.size,
        sales_unresolved: finalUnresolved,
        elapsed_ms: Date.now() - started,
      },
    })

    return NextResponse.json({
      ok: true,
      blocksScanned: targetHeight - lastBlock,
      eventsFound: sales.length,
      salesInserted: inserted,
      salesDuped: duped,
      salesUnresolved: finalUnresolved,
      cursor: lastChunkEnd,
      elapsed: Date.now() - started,
    })
  } catch (err) {
    console.log("[pinnacle-sales-indexer] fatal:", err instanceof Error ? err.message : String(err))
    await logPipelineRun({
      startedAtIso,
      ok: false,
      errorMsg: err instanceof Error ? err.message : String(err),
      extra: { phase: "fatal", elapsed_ms: Date.now() - started },
    })
    return NextResponse.json(
      { error: "Internal server error", details: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    )
  }
}

export async function GET(req: NextRequest) { return runIndexer(req) }
export async function POST(req: NextRequest) { return runIndexer(req) }
