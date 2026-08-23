import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { classifyPinnacleTradeTxs, type PinnacleMoveEvent } from "@/lib/pinnacle/trade-classifier"

// ── Disney Pinnacle TRADE indexer ────────────────────────────────────────────
//
// The third Pinnacle transaction type, alongside the storefront SALE
// (/api/pinnacle-sales-indexer) and the primary MINT
// (supabase/functions/ingest-pinnacle-mints). Pinnacle's in-app peer-to-peer
// trade emits neither a storefront event nor a PinNFTMinted, so before this
// route a traded Pin left no record anywhere in the platform.
//
// ⚠ THE CLASSIFIER IS GEOMETRIC AND NEEDS NO EXTRA FETCHES. A Pinnacle trade
// settles as ONE atomic tx in which exactly two wallets swap Pins in BOTH
// directions. Measured against Flow REST over two independent 10,000-block
// windows on 2026-08-22 and cross-checked in both directions against
// /v1/transaction_results ground truth: 14 trade tx / 77 Pins, zero carrying a
// storefront event; 26 sale-shaped tx, all 26 carrying one. See
// lib/pinnacle/trade-classifier.ts for the rule and
// supabase/migrations/20260822180000_*.sql for the full measurement.
//
// So this route reads only the two Pinnacle streams — Withdraw and Deposit —
// and never has to ask about storefront or mint events at all:
//   • a mint emits Deposit with NO Withdraw     → excluded by requiring a Withdraw
//   • a sale's seller is only `from`, buyer only `to` → fails the both-sides test
//
// Bearer INGEST_SECRET_TOKEN, or Vercel's CRON_SECRET (this route is scheduled
// from vercel.json, which injects CRON_SECRET rather than the ingest token — a
// single-secret gate would 401 every tick, and a 401 writes NO pipeline_runs
// row, which reads exactly like "never scheduled").
//
// Fully SYNCHRONOUS (no after()), so every terminal path logs exactly once
// before returning and the absence of a row genuinely means the route was
// never reached.

export const dynamic = "force-dynamic"
export const maxDuration = 300

const INGEST_TOKEN = process.env.INGEST_SECRET_TOKEN ?? ""
const CRON_TOKEN = process.env.CRON_SECRET ?? ""
const WITHDRAW_EVENT = "A.edf9df96c92f4595.Pinnacle.Withdraw"
const DEPOSIT_EVENT = "A.edf9df96c92f4595.Pinnacle.Deposit"
const FLOW_REST = "https://rest-mainnet.onflow.org"
const CHUNK_SIZE = 250
const MAX_SCAN_RANGE = 2_000
const INTER_CHUNK_DELAY_MS = 75
const PIPELINE_NAME = "pinnacle-trades-indexer"
const COLLECTION_SLUG = "disney_pinnacle"
const CURSOR_ID = "pinnacle_trades"
const PINNACLE_COLLECTION_ID = "7dd9dd11-e8b6-45c4-ac99-71331f959714"

function unauthorized() {
  return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

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
    // ⚠ THROW, DO NOT `return []` — same rule as the 7 sibling block-scan
    // indexers. A non-2xx swallowed into an empty array reaches the chunk loop
    // as a range that read fine and was genuinely empty, so the cursor advances
    // past blocks nothing read. Nothing revisits a block below the cursor.
    throw new Error(`[${PIPELINE_NAME}] ${type.split(".").pop()} ${start}-${end} HTTP ${res.status}`)
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

/**
 * Decode a Pinnacle Withdraw/Deposit event payload into {nftId, address}.
 *
 * Both events carry exactly two fields: `id` (UInt64) and an Optional Address
 * named `from` (Withdraw) or `to` (Deposit). The Optional wrapper is why the
 * address is read through two possible depths. A null address (an Optional that
 * really is nil) returns null and the caller drops the event rather than
 * inventing a counterparty.
 */
function decodeMoveEvent(payloadB64: string): { nftId: string; address: string } | null {
  const raw = JSON.parse(Buffer.from(payloadB64, "base64").toString("utf8"))
  const fields = raw?.value?.fields
  if (!Array.isArray(fields)) return null
  let nftId: string | null = null
  let address: string | null = null
  for (const f of fields) {
    if (f?.name === "id") {
      const v = f?.value?.value
      if (typeof v === "string" || typeof v === "number") nftId = String(v)
    } else if (f?.name === "from" || f?.name === "to") {
      // Optional<Address> → { type: "Optional", value: { type: "Address", value: "0x…" } }
      const inner = f?.value?.value
      const v = inner && typeof inner === "object" ? (inner as any).value : inner
      if (typeof v === "string" && v.length > 0) address = v
    }
  }
  if (!nftId || !address) return null
  return { nftId, address }
}

async function runIndexer(req: NextRequest) {
  const started = Date.now()
  const startedAtIso = new Date(started).toISOString()

  const auth = req.headers.get("authorization") ?? ""
  const bearer = auth.replace(/^Bearer\s+/i, "")
  const urlToken = req.nextUrl.searchParams.get("token") ?? ""
  const presented = bearer || urlToken
  const accepted =
    (INGEST_TOKEN !== "" && presented === INGEST_TOKEN) || (CRON_TOKEN !== "" && presented === CRON_TOKEN)
  // Fails CLOSED when both secrets are unset: `presented` can be "" but neither
  // branch can match an empty configured token.
  if (!accepted) return unauthorized()

  const rangeParam = Number(req.nextUrl.searchParams.get("range") ?? MAX_SCAN_RANGE)
  const maxRange = Math.min(Math.max(rangeParam || MAX_SCAN_RANGE, CHUNK_SIZE), MAX_SCAN_RANGE)

  try {
    const { data: cursorRow, error: cursorErr } = await (supabaseAdmin as any)
      .from("event_cursor")
      .select("last_processed_block")
      .eq("id", CURSOR_ID)
      .single()
    if (cursorErr) {
      console.log(`[${PIPELINE_NAME}] cursor read error:`, cursorErr.message)
      await logPipelineRun({
        startedAtIso,
        ok: false,
        errorMsg: `cursor read: ${cursorErr.message}`,
        extra: { phase: "cursor_read_failed" },
      })
      return NextResponse.json({ error: "Failed to read cursor" }, { status: 500 })
    }

    const lastBlock = Number(cursorRow?.last_processed_block ?? 0)
    const currentHeight = await getLatestSealedHeight()
    if (lastBlock >= currentHeight) {
      // ok:true — "nothing new on chain" is a healthy tick, and the cadence
      // watchlist keys on SILENCE, so a no-op tick must still be recorded or a
      // quiet chain looks identical to a dead pipeline.
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
    console.log(`[${PIPELINE_NAME}] scanning ${lastBlock + 1} → ${targetHeight} (${targetHeight - lastBlock} blocks)`)

    const moves: PinnacleMoveEvent[] = []
    let lastChunkEnd = lastBlock
    // Block of the first chunk that failed to fetch, or null when every chunk
    // read. Once set the per-chunk cursor write stops, so a later successful
    // chunk can never leapfrog a failed one.
    let firstFailedChunkStart: number | null = null
    let decodeFailures = 0

    for (let s = lastBlock + 1; s <= targetHeight; s += CHUNK_SIZE) {
      const e = Math.min(s + CHUNK_SIZE - 1, targetHeight)
      try {
        // Both streams for the SAME range. If either throws, the whole chunk is
        // abandoned — a chunk with only half its events would classify a real
        // trade as a one-way transfer, which is worse than not reading it.
        const [wBlocks, dBlocks] = await Promise.all([
          fetchEventRange(WITHDRAW_EVENT, s, e),
          fetchEventRange(DEPOSIT_EVENT, s, e),
        ])
        for (const [blocks, side] of [[wBlocks, "withdraw"], [dBlocks, "deposit"]] as const) {
          for (const blk of blocks) {
            const bh = Number(blk.block_height)
            const bts = blk.block_timestamp
            for (const evt of blk.events ?? []) {
              try {
                const decoded = decodeMoveEvent(evt.payload)
                if (!decoded) {
                  decodeFailures++
                  continue
                }
                moves.push({
                  side,
                  transactionId: evt.transaction_id,
                  nftId: decoded.nftId,
                  address: decoded.address,
                  blockHeight: bh,
                  blockTimestamp: bts,
                })
              } catch (err) {
                decodeFailures++
                console.log(`[${PIPELINE_NAME}] decode err:`, err instanceof Error ? err.message : String(err))
              }
            }
          }
        }
        lastChunkEnd = e
        if (firstFailedChunkStart === null) {
          await (supabaseAdmin as any)
            .from("event_cursor")
            .update({ last_processed_block: lastChunkEnd, updated_at: new Date().toISOString() })
            .eq("id", CURSOR_ID)
        }
      } catch (err) {
        console.log(`[${PIPELINE_NAME}] chunk ${s}-${e} error:`, err instanceof Error ? err.message : String(err))
        // ⚠ STOP. The cursor is written per chunk, so without the break a later
        // chunk succeeding writes a cursor ABOVE the failed one, leaving the
        // failed range permanently below the cursor where nothing returns.
        // lastChunkEnd already holds the previous chunk's end (s - 1), because
        // it is only ever assigned after a chunk reads cleanly.
        firstFailedChunkStart = s
        break
      }
      if (s + CHUNK_SIZE <= targetHeight) await delay(INTER_CHUNK_DELAY_MS)
    }

    const classified = classifyPinnacleTradeTxs(moves)
    const trades = classified.trades

    console.log(
      `[${PIPELINE_NAME}] ${classified.shapeCounts.trade} trade tx (${trades.length} Pins), ` +
        `${classified.shapeCounts.sale_or_one_way} sale/one-way tx, ` +
        `${classified.shapeCounts.mint_or_deposit_only} deposit-only tx, ` +
        `${classified.shapeCounts.unclassified} unclassified tx`
    )

    // ⚠ `blocks_scanned` reports what was READ, not the range we intended to
    // read — `targetHeight - lastBlock` on a partial scan is a measured-looking
    // number for blocks nothing fetched.
    const partialScanExtra: Record<string, unknown> =
      firstFailedChunkStart !== null
        ? { partial_scan: true, first_failed_chunk: firstFailedChunkStart, cursor_held_from: targetHeight }
        : {}

    // ⚠ The tx-shape census ships on EVERY tick, including empty ones. Pinnacle
    // could change how it settles a trade at any time; if that happened, a lane
    // that only reported its own output would quietly drop to zero trades and
    // read as "a quiet week". A rising `unclassified` count against a falling
    // `trade` count is the signal that the geometry moved.
    const shapeExtra = {
      tx_shapes: classified.shapeCounts,
      trade_tx: classified.shapeCounts.trade,
      pins_traded: trades.length,
      decode_failures: decodeFailures,
    }

    if (trades.length === 0) {
      await logPipelineRun({
        startedAtIso,
        ok: true,
        cursorBefore: lastBlock,
        cursorAfter: lastChunkEnd,
        extra: {
          phase: "no_trades",
          blocks_scanned: Math.max(lastChunkEnd - lastBlock, 0),
          chain_height: currentHeight,
          elapsed_ms: Date.now() - started,
          ...shapeExtra,
          ...partialScanExtra,
        },
      })
      return NextResponse.json({
        ok: true,
        blocksScanned: Math.max(lastChunkEnd - lastBlock, 0),
        tradeTxs: 0,
        pinsTraded: 0,
        // The census ships on the EMPTY path too. An operator curling this route
        // on a zero-trade tick needs to see whether the range held no Pinnacle
        // movement at all or held movement this lane could not classify.
        txShapes: classified.shapeCounts,
        cursor: lastChunkEnd,
        elapsed: Date.now() - started,
      })
    }

    // Resolve nftID → Pinnacle edition_key, same two sources and same order as
    // pinnacle-sales-indexer. An unresolved Pin is written with edition_id NULL
    // and backfills as pinnacle_nft_map grows — NULL means "we cannot name it
    // yet", never "it has no edition".
    const uniqueNftIds = [...new Set(trades.map((t) => t.nftId))]
    const nftToEditionId = new Map<string, string>()

    for (let i = 0; i < uniqueNftIds.length; i += 500) {
      const batch = uniqueNftIds.slice(i, i + 500)
      const { data } = await (supabaseAdmin as any)
        .from("pinnacle_nft_map")
        .select("nft_id, edition_key")
        .in("nft_id", batch)
      for (const row of data ?? []) {
        if (row.edition_key) nftToEditionId.set(String(row.nft_id), row.edition_key)
      }
    }

    const stillUnresolved = uniqueNftIds.filter((id) => !nftToEditionId.has(id))
    if (stillUnresolved.length > 0) {
      for (let i = 0; i < stillUnresolved.length; i += 500) {
        const batch = stillUnresolved.slice(i, i + 500)
        const { data } = await (supabaseAdmin as any)
          .from("wallet_moments_cache")
          .select("moment_id, edition_key")
          .eq("collection_id", PINNACLE_COLLECTION_ID)
          .in("moment_id", batch)
        for (const row of data ?? []) {
          if (row.edition_key) nftToEditionId.set(row.moment_id, row.edition_key)
        }
      }
    }

    const rows = trades.map((t) => ({
      id: `${t.transactionId}_${t.nftId}`,
      transaction_id: t.transactionId,
      nft_id: t.nftId,
      edition_id: nftToEditionId.get(t.nftId) ?? null,
      from_wallet: t.fromWallet,
      to_wallet: t.toWallet,
      traded_at: t.blockTimestamp,
      block_height: t.blockHeight,
      pins_in_trade: t.pinsInTrade,
      source: "on-chain",
    }))

    let inserted = 0
    let duped = 0
    for (let i = 0; i < rows.length; i += 100) {
      const batch = rows.slice(i, i + 100)
      const { error } = await (supabaseAdmin as any)
        .from("pinnacle_trade_events")
        .upsert(batch, { onConflict: "id", ignoreDuplicates: true })
      if (error) {
        // ⚠ A batch .insert() is ALL-OR-NOTHING, so a swallowed 23505 discards
        // every co-batched NEW row. Fall through to row-by-row so real dupes
        // fail individually while new rows land.
        console.log(`[${PIPELINE_NAME}] batch insert err:`, error.message)
        for (const row of batch) {
          const { error: se } = await (supabaseAdmin as any)
            .from("pinnacle_trade_events")
            .upsert(row, { onConflict: "id", ignoreDuplicates: true })
          if (se) duped++
          else inserted++
        }
      } else {
        inserted += batch.length
      }
    }

    const unresolved = trades.filter((t) => !nftToEditionId.has(t.nftId)).length

    await logPipelineRun({
      startedAtIso,
      ok: true,
      rowsFound: trades.length,
      rowsWritten: inserted,
      rowsSkipped: duped,
      cursorBefore: lastBlock,
      cursorAfter: lastChunkEnd,
      extra: {
        phase: "complete",
        blocks_scanned: Math.max(lastChunkEnd - lastBlock, 0),
        chain_height: currentHeight,
        ...shapeExtra,
        ...partialScanExtra,
        unique_nft_ids: uniqueNftIds.length,
        edition_resolved: nftToEditionId.size,
        trades_unresolved: unresolved,
        elapsed_ms: Date.now() - started,
      },
    })

    return NextResponse.json({
      ok: true,
      blocksScanned: Math.max(lastChunkEnd - lastBlock, 0),
      tradeTxs: classified.shapeCounts.trade,
      pinsTraded: trades.length,
      pinsInserted: inserted,
      pinsDuped: duped,
      pinsUnresolved: unresolved,
      txShapes: classified.shapeCounts,
      cursor: lastChunkEnd,
      elapsed: Date.now() - started,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.log(`[${PIPELINE_NAME}] fatal:`, msg)
    await logPipelineRun({ startedAtIso, ok: false, errorMsg: msg, extra: { phase: "fatal" } })
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  return runIndexer(req)
}

// Vercel cron issues a GET.
export async function GET(req: NextRequest) {
  return runIndexer(req)
}
