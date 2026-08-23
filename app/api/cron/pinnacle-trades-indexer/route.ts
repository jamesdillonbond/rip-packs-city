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
// Backfill walks a wider window per tick than forward does, because it has
// ~24.8M blocks to cover and forward only has to keep up with ~2,880 blocks/h.
//
// Raised 10,000 -> 50,000 after two measured ticks, then DIALLED BACK to 25,000
// on 17. ⚠ THE TWO-TICK NUMBER WAS NOT A RATE. At 10,000 blocks two ticks ran
// 4,146 ms and 4,501 ms, implying ~44x headroom. The real distribution at
// 50,000, measured over a night of concurrent load: 17.6s · 24.2s · 27.7s ·
// 31.6s · 36.2s · and one 248.0s that TRIPPED THE SOFT DEADLINE and deferred
// 37,500 blocks. Per-block cost rose as the table grew and other sessions
// worked the same instance, where disk-IO saturation is the dominant problem.
// 25,000 keeps most of the speed-up (~7 days to fill, against ~17 at the
// original 10,000) while halving the per-tick burst on a shared instance.
//
// ⚠ THE SOFT DEADLINE IS WHAT MAKES THIS SAFE, and it is why the raise waited
// until after that shipped. Without it an over-large range is a maxDuration
// kill that leaves NO pipeline_runs row; with it the worst case is a tick that
// covers less ground than planned and a next tick that resumes from the
// committed frontier. The range is now a throughput target, not a risk.
const MAX_BACKFILL_RANGE = 25_000
// Chunks are fetched in ordered WAVES of this size. Measured 2026-08-22: Flow
// REST served 60 concurrent /v1/events reads comfortably, and the first
// (serial) production tick spent 146s on 8 chunks while the second spent 22s —
// so the per-chunk latency is round-trip serialization, not server time.
// ⚠ Waves, not a free-for-all: the no-leapfrog rule needs chunks to retire in
// order, so the cursor only advances to the end of a wave in which EVERY chunk
// read. A failure anywhere in a wave stops the tick at that wave's frontier.
const CHUNK_CONCURRENCY = 5
// Public Flow REST 404s below the current spork floor — pre-spork history needs
// the spork proxy worker, which is a separate workstream.
const SPORK_FLOOR = 137_390_146
// ⚠ SOFT DEADLINE — stop starting waves past this, well under maxDuration=300s.
//
// This is not belt-and-braces. `try/catch` CANNOT catch a maxDuration kill, and
// this route is fully SYNCHRONOUS, so a kill takes the terminal
// log_pipeline_run with it and the tick leaves NO pipeline_runs row at all —
// indistinguishable from "the cron never fired".
//
// Measured on the live forward lane 2026-08-22, same 2,000-block range each
// time: 145,951 ms · 22,330 ms · 3,785 ms · 195,388 ms. ⚠ That is NOT a cold
// start settling down — I called it one after two readings and the fourth
// refuted it. Duration is highly variable and the spread is not in the fetches
// (AbortSignal.timeout bounds those at 15s each, so 8 chunks cannot exceed
// ~120s); the remainder is DB round-trip time on an instance where disk-IO
// saturation is the dominant problem. A backfill tick walks 5x the range, so
// without a deadline a saturation spell could push it past the wall.
//
// 200s leaves ~100s for the resolve + write + log phase that follows the scan.
const SOFT_DEADLINE_MS = 200_000
const INTER_CHUNK_DELAY_MS = 75
const PIPELINE_NAME = "pinnacle-trades-indexer"
const COLLECTION_SLUG = "disney_pinnacle"
const CURSOR_ID = "pinnacle_trades"
// The backfill cursor means the LOWEST block scanned so far, not the highest.
// Seeded at the forward cursor's seed + 1 so the two lanes tile exactly: forward
// owns (162,153,000, tip], backfill owns [SPORK_FLOOR, 162,153,000].
const CURSOR_ID_BACKFILL = "pinnacle_trades_backfill"
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

  // forward  — walk UP from the forward cursor toward the sealed tip (new trades)
  // backfill — walk DOWN from the backfill cursor toward SPORK_FLOOR (history)
  // Anything else is rejected rather than silently treated as forward: a typo in
  // a cron URL must not quietly point the history lane at the live one.
  const modeParam = req.nextUrl.searchParams.get("mode") ?? "forward"
  if (modeParam !== "forward" && modeParam !== "backfill") {
    return NextResponse.json({ error: `unknown mode: ${modeParam}` }, { status: 400 })
  }
  const backfill = modeParam === "backfill"
  const cursorId = backfill ? CURSOR_ID_BACKFILL : CURSOR_ID
  const rangeCap = backfill ? MAX_BACKFILL_RANGE : MAX_SCAN_RANGE

  const rangeParam = Number(req.nextUrl.searchParams.get("range") ?? rangeCap)
  const maxRange = Math.min(Math.max(rangeParam || rangeCap, CHUNK_SIZE), rangeCap)

  try {
    const { data: cursorRow, error: cursorErr } = await (supabaseAdmin as any)
      .from("event_cursor")
      .select("last_processed_block")
      .eq("id", cursorId)
      .single()
    if (cursorErr) {
      console.log(`[${PIPELINE_NAME}] cursor read error:`, cursorErr.message)
      await logPipelineRun({
        startedAtIso,
        ok: false,
        errorMsg: `cursor read: ${cursorErr.message}`,
        extra: { phase: "cursor_read_failed", mode: modeParam },
      })
      return NextResponse.json({ error: "Failed to read cursor" }, { status: 500 })
    }

    const lastBlock = Number(cursorRow?.last_processed_block ?? 0)
    const currentHeight = await getLatestSealedHeight()
    const done = backfill ? lastBlock <= SPORK_FLOOR : lastBlock >= currentHeight
    if (done) {
      // ok:true — "nothing left to scan" is a healthy tick, and the cadence
      // watchlist keys on SILENCE, so a no-op tick must still be recorded or a
      // finished lane looks identical to a dead one.
      //
      // ⚠ For backfill this state is PERMANENT, not transient: the lane has
      // reached the spork floor and every later tick will land here. That is
      // the signal to unschedule it, and `phase` says which of the two it is
      // so nobody reads a finished backfill as a stalled one.
      await logPipelineRun({
        startedAtIso,
        ok: true,
        cursorBefore: lastBlock,
        cursorAfter: lastBlock,
        extra: {
          phase: backfill ? "backfill_floor_reached" : "up_to_date",
          mode: modeParam,
          blocks_scanned: 0,
          chain_height: currentHeight,
          ...(backfill ? { spork_floor: SPORK_FLOOR } : {}),
        },
      })
      return NextResponse.json({
        ok: true,
        message: backfill ? "backfill complete — spork floor reached" : "already up to date",
        cursor: lastBlock,
        elapsed: Date.now() - started,
      })
    }

    // Chunk plan for this tick, in PROCESSING ORDER.
    //   forward:  ascending  over (lastBlock, targetHeight]
    //   backfill: descending over [targetLow, lastBlock - 1]
    // The backfill cursor is the LOWEST block scanned, so it counts DOWN.
    const targetHeight = backfill ? lastBlock : Math.min(lastBlock + maxRange, currentHeight)
    const targetLow = backfill ? Math.max(SPORK_FLOOR, lastBlock - maxRange) : lastBlock + 1

    const chunks: Array<{ s: number; e: number }> = []
    if (backfill) {
      for (let e = lastBlock - 1; e >= targetLow; e -= CHUNK_SIZE) {
        chunks.push({ s: Math.max(e - CHUNK_SIZE + 1, targetLow), e })
      }
    } else {
      for (let c = lastBlock + 1; c <= targetHeight; c += CHUNK_SIZE) {
        chunks.push({ s: c, e: Math.min(c + CHUNK_SIZE - 1, targetHeight) })
      }
    }
    console.log(
      `[${PIPELINE_NAME}] mode=${modeParam} scanning ${chunks.length} chunks ` +
        `${backfill ? `${targetLow} ← ${lastBlock - 1}` : `${lastBlock + 1} → ${targetHeight}`}`
    )

    const moves: PinnacleMoveEvent[] = []
    // The scan frontier: for forward the highest block fully read, for backfill
    // the lowest. Initialised to the cursor so a tick that reads nothing leaves
    // it exactly where it was.
    let frontier = lastBlock
    // Start block of the first chunk that failed to read, or null when every
    // chunk read. Once set the frontier stops moving, so a later successful
    // chunk can never leapfrog a failed range — nothing revisits a block the
    // cursor has already passed.
    let firstFailedChunkStart: number | null = null
    let decodeFailures = 0
    let blocksRead = 0

    // ⚠ WAVES, and the cursor only moves for a wave in which EVERY chunk read.
    // Concurrency inside a wave is safe because a transaction's events all live
    // in ONE block, so no chunk boundary can split a trade across two fetches;
    // ordering between waves is what preserves the no-leapfrog invariant.
    // ⚠ A soft-deadline stop is NOT the same event as a failed read, and they
    // must not share a flag. `partial_scan` means a chunk ERRORED and its range
    // needs investigating; `soft_deadline` means every chunk we attempted read
    // fine and we simply ran out of clock. Conflating them would send someone
    // hunting a Flow REST fault that never happened.
    let softDeadlineHit = false

    for (let w = 0; w < chunks.length; w += CHUNK_CONCURRENCY) {
      if (Date.now() - started > SOFT_DEADLINE_MS) {
        softDeadlineHit = true
        console.log(
          `[${PIPELINE_NAME}] soft deadline at wave ${w / CHUNK_CONCURRENCY}, ` +
            `${chunks.length - w} chunks deferred to the next tick`
        )
        break
      }
      const wave = chunks.slice(w, w + CHUNK_CONCURRENCY)
      const results = await Promise.all(
        wave.map(async (c) => {
          try {
            // Both streams for the SAME range. If either throws, the whole
            // chunk is abandoned — a chunk with only half its events would
            // classify a real trade as a one-way transfer, which is worse than
            // not reading it at all.
            const [wBlocks, dBlocks] = await Promise.all([
              fetchEventRange(WITHDRAW_EVENT, c.s, c.e),
              fetchEventRange(DEPOSIT_EVENT, c.s, c.e),
            ])
            return { c, wBlocks, dBlocks, err: null as string | null }
          } catch (err) {
            return {
              c,
              wBlocks: [] as FlowEventBlock[],
              dBlocks: [] as FlowEventBlock[],
              err: err instanceof Error ? err.message : String(err),
            }
          }
        })
      )

      const failed = results.filter((r) => r.err !== null)
      if (failed.length > 0) {
        for (const f of failed) console.log(`[${PIPELINE_NAME}] chunk ${f.c.s}-${f.c.e} error:`, f.err)
        // The frontier stays at the previous wave's edge. Everything in THIS
        // wave is re-read next tick, including the chunks that succeeded —
        // re-reading is free (the write is an idempotent upsert on a
        // deterministic id) and it is the only way to keep the invariant.
        const lowestFailedChunkStart = Math.min(...failed.map((f) => f.c.s))
        firstFailedChunkStart = lowestFailedChunkStart
        break
      }

      for (const { wBlocks, dBlocks } of results) {
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
      }

      const last = wave[wave.length - 1]
      frontier = backfill ? last.s : last.e
      blocksRead += wave.reduce((n, c) => n + (c.e - c.s + 1), 0)

      await (supabaseAdmin as any)
        .from("event_cursor")
        .update({ last_processed_block: frontier, updated_at: new Date().toISOString() })
        .eq("id", cursorId)

      if (w + CHUNK_CONCURRENCY < chunks.length) await delay(INTER_CHUNK_DELAY_MS)
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
    const partialScanExtra: Record<string, unknown> = {
      ...(firstFailedChunkStart !== null
        ? { partial_scan: true, first_failed_chunk: firstFailedChunkStart, cursor_held_from: targetHeight }
        : {}),
      // Reported on every tick that hit it, including successful ones, so the
      // frequency is visible before it becomes a wall-clock kill.
      ...(softDeadlineHit
        ? { soft_deadline: true, chunks_planned: chunks.length, blocks_deferred: Math.max(
            backfill ? frontier - targetLow : targetHeight - frontier, 0) }
        : {}),
    }

    // ⚠ The tx-shape census ships on EVERY tick, including empty ones. Pinnacle
    // could change how it settles a trade at any time; if that happened, a lane
    // that only reported its own output would quietly drop to zero trades and
    // read as "a quiet week". A rising `unclassified` count against a falling
    // `trade` count is the signal that the geometry moved.
    const shapeExtra = {
      mode: modeParam,
      tx_shapes: classified.shapeCounts,
      // ⚠ Only present when something was unclassified, so an ordinary tick's
      // `extra` stays small. Its absence is the healthy case; its presence is
      // the whole diagnosis, with no re-scan of Flow REST required.
      ...(classified.unclassifiedSample.length > 0
        ? { unclassified_sample: classified.unclassifiedSample }
        : {}),
      trade_tx: classified.shapeCounts.trade,
      pins_traded: trades.length,
      decode_failures: decodeFailures,
    }

    if (trades.length === 0) {
      await logPipelineRun({
        startedAtIso,
        ok: true,
        cursorBefore: lastBlock,
        cursorAfter: frontier,
        extra: {
          phase: "no_trades",
          blocks_scanned: blocksRead,
          chain_height: currentHeight,
          elapsed_ms: Date.now() - started,
          ...shapeExtra,
          ...partialScanExtra,
        },
      })
      return NextResponse.json({
        ok: true,
        blocksScanned: blocksRead,
        tradeTxs: 0,
        pinsTraded: 0,
        // The census ships on the EMPTY path too. An operator curling this route
        // on a zero-trade tick needs to see whether the range held no Pinnacle
        // movement at all or held movement this lane could not classify.
        txShapes: classified.shapeCounts,
        cursor: frontier,
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
      cursorAfter: frontier,
      extra: {
        phase: "complete",
        blocks_scanned: blocksRead,
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
      blocksScanned: blocksRead,
      tradeTxs: classified.shapeCounts.trade,
      pinsTraded: trades.length,
      pinsInserted: inserted,
      pinsDuped: duped,
      pinsUnresolved: unresolved,
      txShapes: classified.shapeCounts,
      cursor: frontier,
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
