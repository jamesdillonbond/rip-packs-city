// app/api/candy-sales-indexer/route.ts
//
// Item 4 — Candy (Solana) secondary-sales indexer. Polls Magic Eden's
// collection `activities` feed (newest-first), resolves each sale's mint to an
// RPC edition via DAS, and writes a `sales` row in USD.
//
// ARMED 2026-07-19: CANDY_MLB_ME_SYMBOL is filled with the verified live symbol
// and a Vercel cron drives this every 3h. Magic Eden currently lists 0 Candy items
// (quest-hold rule) so every tick is a 1-call no-op; the first printed secondary
// sale is captured automatically. The candyMeSymbolReady() short-circuit is kept
// as a guard for any future placeholder state.
//
// Incremental cursor: ME activities are newest-first, so we stop once we cross
// the most-recent already-recorded Candy sale (`sold_at`). The unique tx-hash
// index on sales_2026 is the dedup backstop (23505 swallowed).

import { NextRequest, NextResponse, after } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { writeInvocationHeartbeat } from "@/lib/pipeline/heartbeat"
import { getAsset, solUsd, solUsdOn } from "@/lib/chains/solana/das"
import {
  CANDY_MLB_ME_SYMBOL,
  CANDY_MLB_SLUG,
  CANDY_MLB_UUID,
  candyMeSymbolReady,
  editionKeyFromAsset,
  isPack,
  normalizeSerial,
} from "@/lib/chains/solana/normalize"

export const dynamic = "force-dynamic"
export const maxDuration = 300

const PIPELINE_NAME = "candy-sales-indexer"
const ME_BASE = "https://api-mainnet.magiceden.dev/v2"
const ME_LIMIT = 500
const MAX_PAGES = 40
// Per-request cap on each Magic Eden call. See the note at the fetch itself.
const ME_FETCH_TIMEOUT_MS = 15_000
// Whole-sweep deadline, and a SEPARATE guarantee from the per-request cap — not
// a duplicate of it. ME_FETCH_TIMEOUT_MS bounds ONE call; MAX_PAGES is 40, so
// per-request caps alone still permit 40 x 15s = 600s, twice this route's 300s
// maxDuration. Without a total budget the sweep can still be killed before
// reaching logRun, which is the whole defect being fixed: a killed tick writes
// no terminal row, so the failure is invisible to pipeline_runs.
//
// 240s leaves ~60s for the asset-resolution, drain and logging phases that
// follow the walk. Stopping early just leaves sales for the next tick — the
// cursor only advances over pages actually processed, and unresolved rows are
// retried by design.
const SWEEP_BUDGET_MS = 240_000
// Bound DAS getAsset() calls per tick (edition + serial resolution) so a large
// backlog can't blow the lambda budget — unresolved sales are retried next tick.
const ASSET_FETCH_BUDGET = 400
// Dead-letter drain: rows re-attempted per tick, and the attempt ceiling after
// which a row stops consuming budget (it stays open and countable, it just
// stops being retried).
const DRAIN_LIMIT = 60
const MAX_PARK_ATTEMPTS = 25
// A sealed-pack sale is permanently unresolvable as an EDITION sale (packs are
// not editions). Parked and closed in the same breath: the row is kept as the
// only record RPC has of Candy pack secondary pricing, but never retried.
const PACK_SKIP = "pack_asset"
const DUST_SKIP = "dust_price_rounds_to_zero"
// Skips that can NEVER succeed on a retry: the input itself is terminal, not
// missing. Parked, then closed in the same pass so they don't burn drain budget
// (or sit in the dead letter forever once attempts hit MAX_PARK_ATTEMPTS).
const TERMINAL_SKIPS = new Set([PACK_SKIP, DUST_SKIP])

interface MeActivity {
  signature: string
  type: string
  tokenMint?: string
  buyer?: string | null
  seller?: string | null
  price?: number // SOL
  blockTime?: number // unix seconds
  source?: string
}

// Sale activity types ME emits for a completed purchase. "list" is a listing,
// not a sale — excluded.
const SALE_TYPES = new Set(["buyNow", "buyNowFill", "acceptBid"])

// A sale seen on the feed that could not be turned into a `sales` row this
// tick. Shape mirrors public.candy_sales_unresolved.
interface ParkedSale {
  signature: string
  token_mint: string
  block_time: string | null
  price_sol: number | null
  buyer: string | null
  seller: string | null
  reason: string
}

async function fetchActivities(offset: number): Promise<MeActivity[]> {
  const headers: Record<string, string> = { Accept: "application/json" }
  const key = process.env.MAGIC_EDEN_API_KEY
  if (key) headers["Authorization"] = `Bearer ${key}`
  const url = `${ME_BASE}/collections/${encodeURIComponent(CANDY_MLB_ME_SYMBOL)}/activities?offset=${offset}&limit=${ME_LIMIT}`
  // 15s cap. `fetch()` has no default timeout, and this route runs inside
  // `after()` with maxDuration 300 — so an upstream that accepts the connection
  // and holds it open consumes the whole budget, and a maxDuration kill writes
  // NO terminal pipeline_runs row, making the outage invisible. Measured on the
  // sibling /api/candy-listings-indexer 2026-08-27 (15 heartbeats, ONE terminal
  // row in 48h, public board 44h stale) and fixed there the same evening.
  //
  // ⚠ This route is the one already observed taking Cloudflare 1015 rate-limits
  // (HTTP 429) from Vercel against this same Magic Eden host, so it is the most
  // exposed caller of the pattern, not a speculative one.
  const resp = await fetch(url, { headers, signal: AbortSignal.timeout(ME_FETCH_TIMEOUT_MS) })
  if (!resp.ok) {
    throw new Error(`ME activities HTTP ${resp.status}: ${(await resp.text().catch(() => "")).slice(0, 200)}`)
  }
  const json = await resp.json()
  return Array.isArray(json) ? (json as MeActivity[]) : []
}

async function logRun(
  startedAtIso: string,
  rowsFound: number,
  rowsWritten: number,
  rowsSkipped: number,
  ok: boolean,
  error: string | null,
  cursorBefore: string | null,
  cursorAfter: string | null,
  extra: Record<string, unknown>
) {
  try {
    await (supabaseAdmin as any).rpc("log_pipeline_run", {
      p_pipeline: PIPELINE_NAME,
      p_started_at: startedAtIso,
      p_rows_found: rowsFound,
      p_rows_written: rowsWritten,
      p_rows_skipped: rowsSkipped,
      p_ok: ok,
      p_error: error,
      p_collection_slug: CANDY_MLB_SLUG,
      p_cursor_before: cursorBefore,
      p_cursor_after: cursorAfter,
      p_extra: extra,
    })
  } catch (e) {
    console.log(
      `[${PIPELINE_NAME}] log_pipeline_run failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`
    )
  }
}

// INGEST_SECRET_TOKEN (GitHub Actions / manual / cron-job.org) OR Bearer
// CRON_SECRET (Vercel cron sends only CRON_SECRET). Both are equivalent-trust
// server secrets. The GET handler exists so the Vercel cron — which always invokes
// via GET — can drive the poll; manual/operator runs POST. Mirrors the auth shape
// of app/api/ingest/candy-editions/route.ts.
function authed(req: NextRequest): boolean {
  const header = req.headers.get("authorization") ?? ""
  const ingest = process.env.INGEST_SECRET_TOKEN
  const cron = process.env.CRON_SECRET
  if (ingest && header === `Bearer ${ingest}`) return true
  if (cron && header === `Bearer ${cron}`) return true
  return false
}

export async function GET(req: NextRequest) {
  return handleIndex(req)
}

export async function POST(req: NextRequest) {
  return handleIndex(req)
}

async function handleIndex(req: NextRequest) {
  if (!authed(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const startedAtIso = new Date().toISOString()
  const startedMs = Date.now()

  if (!candyMeSymbolReady()) {
    await logRun(startedAtIso, 0, 0, 0, true, null, null, null, {
      skip_reason: "discovery_pending",
      note: "CANDY_MLB_ME_SYMBOL not configured (still a TODO_-prefixed placeholder)",
    })
    return NextResponse.json(
      { accepted: false, skipped: "discovery_pending", collection: CANDY_MLB_SLUG },
      { status: 202 }
    )
  }

  after(async () => {
    // Invocation heartbeat, FIRST statement of after(): a `maxDuration` kill
    // runs neither the success path nor the catch, so without this marker a
    // killed tick is indistinguishable from a cron that never fired — and this
    // pipeline is on `pipeline_cadence_watchlist`, so the two produce the same
    // alert and need opposite responses. The separate `-heartbeat` name is
    // required: a marker under the REAL name would refresh `last_run` every
    // tick and silence `detect_stalled_pipelines()` on the outage it exposes.
    await writeInvocationHeartbeat({ pipeline: PIPELINE_NAME, startedAtMs: Date.parse(startedAtIso) })
    let found = 0
    let written = 0
    let skipped = 0
    let assetFetches = 0
    let packSales = 0
    let cursorAfter: string | null = null
    try {
      // Incremental high-water mark: the most recent Candy sale we already have.
      const { data: latest } = await (supabaseAdmin as any)
        .from("sales")
        .select("sold_at")
        .eq("collection_id", CANDY_MLB_UUID)
        .order("sold_at", { ascending: false })
        .limit(1)
      const cursorBeforeMs: number = latest?.[0]?.sold_at
        ? new Date(latest[0].sold_at).getTime()
        : 0
      const cursorBefore = cursorBeforeMs ? new Date(cursorBeforeMs).toISOString() : null

      const rate = await solUsd()
      // edition_key → editions.id cache (so repeat keys cost one query).
      const edIdByKey = new Map<string, string | null>()

      // A sale we SEE but cannot write used to be counted `skipped` and then
      // dropped. ME only re-offers it while it is still newer than
      // max(sold_at), so the moment ANY newer sale lands the cursor steps over
      // it and it is gone for good — 37 of 359 activities across the first 25
      // runs, invisibly, under ok=true. Park it instead; the drain below
      // re-attempts the backlog every tick.
      const parked: ParkedSale[] = []
      const park = (
        signature: string,
        tokenMint: string,
        tMs: number,
        price: number | null | undefined,
        buyer: string | null | undefined,
        seller: string | null | undefined,
        reason: string
      ) => {
        skipped++
        parked.push({
          signature,
          token_mint: tokenMint,
          block_time: tMs ? new Date(tMs).toISOString() : null,
          price_sol: price ?? null,
          buyer: buyer ?? null,
          seller: seller ?? null,
          reason,
        })
      }

      const parkRpc = async (p: ParkedSale) => {
        await (supabaseAdmin as any).rpc("candy_park_unresolved_sale", {
          p_signature: p.signature,
          p_token_mint: p.token_mint,
          p_block_time: p.block_time,
          p_price_sol: p.price_sol,
          p_buyer: p.buyer,
          p_seller: p.seller,
          p_skip_reason: p.reason,
        })
      }

      const closeParked = async (signature: string, tokenMint: string, resolution: string) => {
        await (supabaseAdmin as any)
          .from("candy_sales_unresolved")
          .update({ resolved_at: new Date().toISOString(), resolution })
          .eq("signature", signature)
          .eq("token_mint", tokenMint)
      }

      // Resolve one ME sale into a `sales` row, or say why it cannot be. Shared
      // by the live walk and the dead-letter drain so both classify identically.
      async function buildSaleRow(
        signature: string,
        tokenMint: string,
        tMs: number,
        price: number | null | undefined,
        buyer: string | null | undefined,
        seller: string | null | undefined
      ): Promise<{ row: Record<string, unknown> } | { skip: string }> {
        if (price == null || price <= 0) return { skip: "no_price" }
        // Price this sale on the SOL/USD rate that prevailed on its OWN trade day
        // (falls back to the tick's spot rate for same-day sales or if the history
        // lookup is unavailable — never worse than spot), so the drain's
        // re-attempts of days-old parked sales are priced honestly.
        const saleRate = await solUsdOn(tMs)
        if (saleRate == null) return { skip: "no_sol_rate" }
        // Every downstream consumer reads price_usd, which is price*rate ROUNDED to
        // cents — so a positive-but-dust SOL amount still lands as 0.00 and the
        // `price <= 0` guard above does not catch it. This is not hypothetical: the
        // single candy row that reached `sales` at price_usd = 0 was 0.00000100 SOL
        // (~$0.000076) on 2026-07-23 — one microSOL of wash/dust, not a price.
        // `sales` has no CHECK (price_usd > 0) to stop it, and a $0 sale drags every
        // average that reads the edition. Guard the ROUNDED value: that also filters
        // sub-half-cent dust by construction, with no invented threshold.
        const priceUsd = Number((price * saleRate).toFixed(2))
        if (!(priceUsd > 0)) return { skip: DUST_SKIP }
        if (assetFetches >= ASSET_FETCH_BUDGET) return { skip: "asset_budget_exhausted" }

        // Resolve mint → edition via DAS.
        let asset
        try {
          asset = await getAsset(tokenMint)
          assetFetches++
        } catch {
          return { skip: "das_fetch_failed" }
        }
        // The ME collection MIXES sealed PACK assets (Item Type=Pack) with the
        // individual ICONs, and packs are deliberately not editions — so a pack
        // sale can NEVER resolve. Classify it so it neither masquerades as a
        // catalog gap nor burns the drain budget forever. Verified live
        // 2026-07-27: the first three rows the dead letter caught were all
        // sealed packs trading at 0.39-0.45 SOL (~$30-34) against $10 retail.
        if (isPack(asset)) {
          // Record it. A pack has no edition, so it can never be a `sales` row —
          // but the price is real market signal (the first three we caught were
          // 0.39-0.45 SOL against a $10 retail pack) and candy_pack_market is
          // the only place it is published. NEVER folded into fmv_snapshots.
          const { error: pe } = await (supabaseAdmin as any)
            .from("candy_pack_sales")
            .upsert(
              {
                transaction_hash: signature,
                token_mint: tokenMint,
                collection_id: CANDY_MLB_UUID,
                serial_number: normalizeSerial(asset).serial_number,
                price_sol: price,
                price_usd: priceUsd,
                buyer: buyer ?? null,
                seller: seller ?? null,
                sold_at: new Date(tMs).toISOString(),
              },
              { onConflict: "transaction_hash,token_mint" }
            )
          if (pe) console.log(`[${PIPELINE_NAME}] candy_pack_sales upsert err: ${pe.message}`)
          return { skip: PACK_SKIP }
        }

        const key = editionKeyFromAsset(asset)
        const serial = normalizeSerial(asset).serial_number
        if (!key || serial == null) return { skip: "unresolvable_serial" }

        let editionId = edIdByKey.get(key)
        if (editionId === undefined) {
          const { data: edRow } = await (supabaseAdmin as any)
            .from("editions")
            .select("id")
            .eq("external_id", key)
            .eq("collection_id", CANDY_MLB_UUID)
            .limit(1)
          editionId = edRow?.[0]?.id ?? null
          edIdByKey.set(key, editionId ?? null)
        }
        if (!editionId) {
          // Edition not ingested yet — the daily editions ingest fills it and
          // the drain re-attempts this sale on a later tick.
          return { skip: "edition_not_ingested" }
        }

        return {
          row: {
            id: crypto.randomUUID(),
            edition_id: editionId,
            collection_id: CANDY_MLB_UUID,
            collection: CANDY_MLB_SLUG,
            nft_id: tokenMint,
            serial_number: serial,
            price_usd: priceUsd,
            price_native: price,
            currency: "SOL",
            marketplace: "magic_eden",
            source: "solana_das",
            transaction_hash: signature,
            sold_at: new Date(tMs).toISOString(),
            buyer_address: buyer ?? null,
            seller_address: seller ?? null,
            ingested_at: new Date().toISOString(),
          },
        }
      }

      // A batch insert is all-or-nothing: a SINGLE duplicate transaction_hash
      // (23505) — or any other row-level error — fails the whole statement and
      // writes NONE of the batch, silently dropping the co-batched NEW sales.
      // (Reachable during offset-pagination overlap and for multi-item ME txns
      // that share a signature.) Retry row-by-row so genuine dupes are skipped
      // individually while the new rows still land.
      async function insertSales(rows: Record<string, unknown>[]) {
        for (let i = 0; i < rows.length; i += 100) {
          const batch = rows.slice(i, i + 100)
          const { error } = await (supabaseAdmin as any).from("sales").insert(batch)
          if (error) {
            if (error.code !== "23505") {
              console.log(`[${PIPELINE_NAME}] sales insert err: ${error.message}`)
            }
            for (const row of batch) {
              const { error: se } = await (supabaseAdmin as any).from("sales").insert(row)
              if (!se) {
                written++
              } else if (se.code !== "23505") {
                // A non-duplicate row-level failure: the cursor is about to step
                // past this sale, so dropping it here is PERMANENT loss. Park it
                // to the dead letter (reason insert_failed:<code>) so the drain
                // path retries it on a later tick — mirroring how the drain loop
                // below already handles the same failure.
                park(
                  String(row.transaction_hash),
                  String(row.nft_id),
                  row.sold_at ? new Date(String(row.sold_at)).getTime() : 0,
                  typeof row.price_native === "number" ? row.price_native : null,
                  (row.buyer_address as string | null) ?? null,
                  (row.seller_address as string | null) ?? null,
                  `insert_failed:${se.code ?? "unknown"}`
                )
              }
              // else: a genuine 23505 duplicate — already recorded, skip silently.
            }
          } else {
            written += batch.length
          }
        }
      }

      let activitiesSeen = 0
      let reachedKnown = false
      let budgetExhausted = false
      for (let page = 0; page < MAX_PAGES && !reachedKnown; page++) {
        // Stop before the lambda is killed, so logRun below always runs.
        if (Date.now() - startedMs > SWEEP_BUDGET_MS) {
          budgetExhausted = true
          break
        }
        const acts = await fetchActivities(page * ME_LIMIT)
        activitiesSeen += acts.length
        if (acts.length === 0) break

        const salesRows: Record<string, unknown>[] = []
        for (const a of acts) {
          const tMs = (a.blockTime ?? 0) * 1000
          // Stop once we cross into already-recorded territory (with the page
          // still processed up to the boundary; DB dedup covers any overlap).
          if (cursorBeforeMs && tMs <= cursorBeforeMs) {
            reachedKnown = true
            continue
          }
          if (!SALE_TYPES.has(a.type) || !a.tokenMint || !a.signature) continue
          found++
          if (tMs > (cursorAfter ? new Date(cursorAfter).getTime() : 0)) {
            cursorAfter = new Date(tMs).toISOString()
          }

          const built = await buildSaleRow(a.signature, a.tokenMint, tMs, a.price, a.buyer, a.seller)
          if ("skip" in built) {
            park(a.signature, a.tokenMint, tMs, a.price, a.buyer, a.seller, built.skip)
            if (built.skip === PACK_SKIP) packSales++
            continue
          }
          salesRows.push(built.row)
        }

        await insertSales(salesRows)

        if (acts.length < ME_LIMIT) break
      }

      // Park (or re-park, incrementing attempts) everything this tick saw and
      // could not write.
      // A pack sale is closed out in the same pass — recorded, never retried.
      for (const p of parked) {
        await parkRpc(p)
        if (TERMINAL_SKIPS.has(p.reason)) await closeParked(p.signature, p.token_mint, p.reason)
      }

      // Drain the dead letter with whatever asset budget the live walk left —
      // live capture always has first claim on it. Oldest first: those are the
      // rows the cursor has already stepped past, so nothing else will re-offer
      // them.
      let drainAttempted = 0
      let drainResolved = 0
      const { data: owed } = await (supabaseAdmin as any)
        .from("candy_sales_unresolved")
        .select("signature, token_mint, block_time, price_sol, buyer, seller")
        .is("resolved_at", null)
        .lt("attempts", MAX_PARK_ATTEMPTS)
        .order("block_time", { ascending: true })
        .limit(DRAIN_LIMIT)
      for (const r of owed ?? []) {
        if (assetFetches >= ASSET_FETCH_BUDGET) break
        drainAttempted++
        const tMs = r.block_time ? new Date(r.block_time).getTime() : 0
        const price = r.price_sol == null ? null : Number(r.price_sol)
        const built = await buildSaleRow(r.signature, r.token_mint, tMs, price, r.buyer, r.seller)
        if ("skip" in built) {
          await parkRpc({
            signature: r.signature,
            token_mint: r.token_mint,
            block_time: r.block_time ?? null,
            price_sol: price,
            buyer: r.buyer ?? null,
            seller: r.seller ?? null,
            reason: built.skip,
          })
          if (TERMINAL_SKIPS.has(built.skip)) {
            await closeParked(r.signature, r.token_mint, built.skip)
            if (built.skip === PACK_SKIP) packSales++
          }
          continue
        }
        const { error } = await (supabaseAdmin as any).from("sales").insert(built.row)
        if (!error) {
          written++
          drainResolved++
          await closeParked(r.signature, r.token_mint, "written")
        } else if (error.code === "23505") {
          // `sales` dedups on transaction_hash alone, so a second item under the
          // same ME signature can never land. Close it out rather than retry it
          // to the attempt ceiling.
          await closeParked(r.signature, r.token_mint, "duplicate_tx_hash")
        } else {
          await parkRpc({
            signature: r.signature,
            token_mint: r.token_mint,
            block_time: r.block_time ?? null,
            price_sol: price,
            buyer: r.buyer ?? null,
            seller: r.seller ?? null,
            reason: `insert_failed:${error.code ?? "unknown"}`,
          })
        }
      }

      const { count: unresolvedOpen } = await (supabaseAdmin as any)
        .from("candy_sales_unresolved")
        .select("signature", { count: "exact", head: true })
        .is("resolved_at", null)

      // An entirely empty activities response is an upstream fault, not a quiet
      // market: this collection prints mints/bids/lists continuously, and ME's
      // public arms for this symbol are known to serve degraded answers (its
      // /stats arm echoes `listedCount: 0` for ANY symbol). Reporting ok=true on
      // it is the silent-degradation shape — found=0, written=0, "healthy".
      // ⚠ `budgetExhausted` must be excluded here, and this is not a nicety.
      // If the sweep deadline fires before the first page lands, activitiesSeen
      // is 0 for a reason that has NOTHING to do with the upstream — and this
      // line would then publish "upstream fault" about OUR OWN timeout. That is
      // the honesty canon inverted: not a failed read rendering as a fact, but a
      // local failure rendering as someone else's fault. The two states get
      // different messages, and `budget_exhausted` in `extra` carries the
      // distinction for anything querying it.
      const feedErr = budgetExhausted
        ? "sweep budget exhausted before the activities walk completed — no upstream claim implied"
        : activitiesSeen === 0
          ? "ME activities feed returned 0 rows — upstream fault, not a quiet market"
          : null

      await logRun(startedAtIso, found, written, skipped, feedErr === null, feedErr, cursorBefore, cursorAfter, {
        sales_found: found,
        sales_written: written,
        skipped,
        // Distinguishes "we walked the whole feed" from "we ran out of time".
        // Without it a time-truncated sweep and a genuinely short feed report
        // identically — the empty-vs-unavailable conflation in a new place.
        budget_exhausted: budgetExhausted,
        parked: parked.length,
        pack_sales_seen: packSales,
        drain_attempted: drainAttempted,
        drain_resolved: drainResolved,
        unresolved_open: unresolvedOpen ?? 0,
        activities_seen: activitiesSeen,
        asset_fetches: assetFetches,
        me_key_present: Boolean(process.env.MAGIC_EDEN_API_KEY),
        sol_usd: rate,
        duration_ms: Date.now() - startedMs,
      })
    } catch (e) {
      await logRun(startedAtIso, found, written, skipped, false, e instanceof Error ? e.message : String(e), null, cursorAfter, {
        sales_found: found,
        sales_written: written,
        skipped,
      })
    }
  })

  return NextResponse.json(
    { accepted: true, collection: CANDY_MLB_SLUG, started_at: startedAtIso },
    { status: 202 }
  )
}
