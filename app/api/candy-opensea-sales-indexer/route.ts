// app/api/candy-opensea-sales-indexer/route.ts
//
// Candy (Solana) secondary SALES that cleared on OPENSEA. Until this route every
// Candy row in `sales` came from Magic Eden's activities feed
// (/api/candy-sales-indexer), so a Candy trade on OpenSea, where Candy Digital is
// a named Solana launch partner, never reached FMV, the boards or any history.
//
// Source: GET /api/v2/events/collection/{slug}?event_type=sale (spec
// `SaleEvent`: transaction, event_timestamp, payment {quantity, decimals,
// symbol}, seller, buyer, nft.identifier, protocol_address). Plumbing and the
// spec provenance: lib/chains/solana/opensea.ts.
//
// ── DEDUP AGAINST MAGIC EDEN, BY CONSTRUCTION ──────────────────────────────────
// OpenSea's event feed may also report trades that settled on Magic Eden. Two
// guards keep such a trade from being written twice or under the wrong venue:
//   1. TIME: a window is only processed once it ends before the start of the
//      latest COMPLETE Magic Eden sales run (ok, not budget-exhausted). Any trade
//      Magic Eden reports in that span is therefore already in `sales` as
//      magic_eden before this route can see it.
//   2. SIGNATURE: every candidate is checked against existing Candy `sales` and
//      `candy_pack_sales` rows by transaction signature, any marketplace. A hit
//      is skipped and counted (`skipped_known_signature`). The unique index on
//      (transaction_hash, nft_id, sold_at) stays the last backstop.
//
// ── CURSOR: STORED, WINDOWED, OLDEST-FIRST ─────────────────────────────────────
// event_cursor id `candy_opensea_sales`; ⚠ its `last_processed_block` column
// holds UNIX SECONDS here, not a block height. Windows of ≤ 1 day are walked
// oldest-first from OpenSea's Solana launch (2026-08-31). The cursor advances
// only past a window walked to its end; a page cap or the budget leaves it
// where it was, so a cut-off walk is re-read, never skipped.
// A sale that could not be written for a RETRYABLE reason (edition not yet
// ingested, DAS/rate lookup failed, insert error) HOLDS the cursor just before
// it, so the next tick retries it. Once the cursor has not moved for
// HOLD_MAX_DAYS (event_cursor.updated_at), the blocking sales are passed and
// counted in `abandoned` with their signatures, never dropped silently.
// ⚠ The age is the CURSOR's, not the sale's: during the backfill every sale is
// days old, and keying on sale age would abandon each retryable miss at once.
//
// ⚠ `marketplace: 'opensea'`, `source: 'opensea_api'`. The Magic Eden route's
// `source: 'solana_das'` names its resolver; this one names its feed. A new
// Candy source tag in a source-mix watch is EXPECTED from 2026-10-10.

import { NextRequest, NextResponse, after } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { writeInvocationHeartbeat } from "@/lib/pipeline/heartbeat"
import { getAsset, solUsdOn } from "@/lib/chains/solana/das"
import {
  CANDY_MLB_SLUG,
  CANDY_MLB_UUID,
  editionKeyFromAsset,
  isPack,
  normalizeSerial,
} from "@/lib/chains/solana/normalize"
import { OS_PAGE_LIMIT, discoverCandyOpenSeaSlug, openSeaApiKey, osGet } from "@/lib/chains/solana/opensea"

export const dynamic = "force-dynamic"
export const maxDuration = 300

const PIPELINE_NAME = "candy-opensea-sales-indexer"
const ME_SALES_PIPELINE = "candy-sales-indexer"
const CURSOR_ID = "candy_opensea_sales"
// OpenSea's Solana NFT trading launched ~2026-08-31; nothing to read before it.
const DEFAULT_START_SEC = Math.floor(Date.parse("2026-08-31T00:00:00Z") / 1000)
const WINDOW_SEC = 86_400
// Overlap each window's lower bound so a boundary event is never missed; the
// signature dedup absorbs the re-read.
const OVERLAP_SEC = 60
// Margin before the Magic Eden run's start, so its in-flight tail is excluded.
const ME_MARGIN_SEC = 600
const MAX_PAGES_PER_WINDOW = 25
const SWEEP_BUDGET_MS = 240_000
// DAS lookups per tick for mints wallet_moments_cache does not know.
const ASSET_FETCH_BUDGET = 150
const HOLD_MAX_DAYS = 3

interface OsSaleEvent {
  event_type?: string
  event_timestamp?: number
  transaction?: string
  protocol_address?: string
  payment?: { quantity?: string; decimals?: number; symbol?: string }
  seller?: string
  buyer?: string
  quantity?: number
  nft?: { identifier?: string } | null
}

/**
 * Convert a sale's `payment` to { native, currency, usd } priced on the sale's
 * OWN day (SOL via solUsdOn, a stablecoin at face). null = not convertible.
 */
export async function salePrice(
  p: OsSaleEvent["payment"],
  tMs: number,
): Promise<{ native: number; currency: string; usd: number } | { skip: string }> {
  if (!p || p.quantity == null || p.decimals == null) return { skip: "no_payment" }
  const raw = Number(p.quantity)
  if (!Number.isFinite(raw) || raw <= 0) return { skip: "no_payment" }
  const amount = raw / Math.pow(10, p.decimals)
  const sym = String(p.symbol ?? "").toUpperCase()
  let usd: number
  if (sym === "SOL" || sym === "WSOL") {
    const rate = await solUsdOn(tMs)
    if (rate == null) return { skip: "no_sol_rate" }
    usd = Number((amount * rate).toFixed(2))
  } else if (sym === "USDC" || sym === "USDT") {
    usd = Number(amount.toFixed(2))
  } else {
    return { skip: `unsupported_currency:${sym || "none"}` }
  }
  // Rounded-to-zero dust is not a price (see candy-sales-indexer's DUST_SKIP).
  if (!(usd > 0)) return { skip: "dust_price_rounds_to_zero" }
  return { native: amount, currency: sym === "WSOL" ? "SOL" : sym, usd }
}

// Skips that a retry cannot fix: passed immediately, counted, never held.
const TERMINAL_SKIPS = new Set(["no_payment", "dust_price_rounds_to_zero", "not_candy", "multi_quantity"])

async function logRun(
  startedAtIso: string,
  rowsFound: number,
  rowsWritten: number,
  rowsSkipped: number,
  ok: boolean,
  error: string | null,
  cursorBefore: string | null,
  cursorAfter: string | null,
  extra: Record<string, unknown>,
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
    console.log(`[${PIPELINE_NAME}] log_pipeline_run failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`)
  }
}

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

const isoSec = (s: number) => new Date(s * 1000).toISOString()

async function handleIndex(req: NextRequest) {
  if (!authed(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const startedAtIso = new Date().toISOString()
  const startedMs = Date.now()

  await writeInvocationHeartbeat({
    pipeline: PIPELINE_NAME,
    startedAtMs: startedMs,
    collectionSlug: CANDY_MLB_SLUG,
  })

  const apiKey = openSeaApiKey()
  if (!apiKey) {
    console.error(`[${PIPELINE_NAME}] OPENSEA_API_KEY is not set — no OpenSea Candy sales can be read`)
    await logRun(startedAtIso, 0, 0, 0, false, "OPENSEA_API_KEY not set (misconfiguration, not an OpenSea outage)", null, null, {
      skip_reason: "opensea_key_missing",
    })
    return NextResponse.json(
      { accepted: false, skipped: "opensea_key_missing", collection: CANDY_MLB_SLUG },
      { status: 202 },
    )
  }

  after(async () => {
    let found = 0
    let written = 0
    let skipped = 0
    let cursorBefore: string | null = null
    let cursorAfter: string | null = null
    let slug: string | null = null
    const counts: Record<string, number> = {}
    const bump = (k: string) => (counts[k] = (counts[k] ?? 0) + 1)
    const protocols: Record<string, number> = {}
    const writeErrors: string[] = []
    const abandoned: Array<{ signature: string; reason: string }> = []
    let windowsCompleted = 0
    let windowTruncated = false
    let budgetExhausted = false
    let packSalesWritten = 0
    let assetFetches = 0
    let meCeilingSec: number | null = null
    try {
      const d = await discoverCandyOpenSeaSlug(supabaseAdmin, apiKey)
      slug = d.slug
      if (!slug) {
        await logRun(startedAtIso, 0, 0, 0, false, `OpenSea collection slug not found (${d.how})`, null, null, {
          skip_reason: "slug_not_found",
          slug_discovery: d.how,
        })
        return
      }

      // ── Cursor ──────────────────────────────────────────────────────────────
      const { data: cur, error: curErr } = await (supabaseAdmin as any)
        .from("event_cursor")
        .select("last_processed_block, updated_at")
        .eq("id", CURSOR_ID)
        .maybeSingle()
      // A failed read is NOT "no cursor yet": falling to the default would
      // rewind a walk that had advanced.
      if (curErr) throw new Error(`cursor read failed: ${curErr.message}`)
      const startSec = cur?.last_processed_block != null ? Number(cur.last_processed_block) : DEFAULT_START_SEC
      cursorBefore = isoSec(startSec)
      // How long the stored cursor has sat still. Reset once it moves this tick.
      let stuckMs = cur?.updated_at ? Date.now() - Date.parse(cur.updated_at) : 0

      // ── Ceiling: the start of the latest COMPLETE Magic Eden sales run ───────
      const { data: meRun, error: meErr } = await (supabaseAdmin as any)
        .from("pipeline_runs")
        .select("started_at")
        .eq("pipeline", ME_SALES_PIPELINE)
        .eq("ok", true)
        .eq("extra->>budget_exhausted", "false")
        .order("started_at", { ascending: false })
        .limit(1)
      if (meErr) throw new Error(`Magic Eden run read failed: ${meErr.message}`)
      const meStarted = meRun?.[0]?.started_at ? Date.parse(meRun[0].started_at) : NaN
      if (!Number.isFinite(meStarted)) {
        // No proof Magic Eden has swept anything: process nothing rather than
        // risk recording a Magic Eden trade as OpenSea's.
        await logRun(startedAtIso, 0, 0, 0, false, "no complete Magic Eden sales run on record — OpenSea sales held", cursorBefore, cursorBefore, {
          slug,
          skip_reason: "me_ceiling_unknown",
        })
        return
      }
      meCeilingSec = Math.floor(meStarted / 1000) - ME_MARGIN_SEC

      // ── Walk windows oldest-first ─────────────────────────────────────────
      const editionIdByKey = new Map<string, string | null>()
      let cursorSec = startSec
      let held = false
      while (!held && cursorSec < meCeilingSec) {
        if (Date.now() - startedMs > SWEEP_BUDGET_MS) {
          budgetExhausted = true
          break
        }
        const winStart = cursorSec
        const winEnd = Math.min(cursorSec + WINDOW_SEC, meCeilingSec)

        const events: OsSaleEvent[] = []
        let next: string | null = null
        let complete = false
        for (let p = 0; p < MAX_PAGES_PER_WINDOW; p++) {
          if (Date.now() - startedMs > SWEEP_BUDGET_MS) {
            budgetExhausted = true
            break
          }
          const qs =
            `event_type=sale&after=${winStart - OVERLAP_SEC}&before=${winEnd}&limit=${OS_PAGE_LIMIT}` +
            (next ? `&next=${encodeURIComponent(next)}` : "")
          const { json } = await osGet(`/events/collection/${encodeURIComponent(slug)}?${qs}`, apiKey)
          for (const e of (json?.asset_events ?? []) as OsSaleEvent[]) if (e?.event_type === "sale") events.push(e)
          next = json?.next ?? null
          if (!next) {
            complete = true
            break
          }
        }
        if (!complete) {
          // Page cap or budget: leave the cursor where it is, re-read next tick.
          if (!budgetExhausted) windowTruncated = true
          break
        }

        // Candidates inside this window (the overlap re-reads are deduped below).
        const cands = events
          .map((e) => ({
            e,
            sig: e.transaction ?? "",
            mint: e.nft?.identifier ?? "",
            tSec: Number(e.event_timestamp ?? 0),
          }))
          .filter((c) => c.sig && c.mint && c.tSec > 0 && c.tSec <= winEnd)
        for (const c of cands) {
          const k = c.e.protocol_address ?? "(none)"
          protocols[k] = (protocols[k] ?? 0) + 1
        }
        found += cands.length

        // Signature dedup against EVERY Candy sale and pack sale on record.
        const sigs = [...new Set(cands.map((c) => c.sig))]
        const known = new Set<string>()
        for (let i = 0; i < sigs.length; i += 200) {
          const slice = sigs.slice(i, i + 200)
          const { data: s1, error: e1 } = await (supabaseAdmin as any)
            .from("sales")
            .select("transaction_hash, nft_id")
            .eq("collection_id", CANDY_MLB_UUID)
            .in("transaction_hash", slice)
          if (e1) throw new Error(`sales signature read failed: ${e1.message}`)
          for (const r of (s1 ?? []) as Array<{ transaction_hash: string; nft_id: string }>) known.add(`${r.transaction_hash}|${r.nft_id}`)
          const { data: s2, error: e2 } = await (supabaseAdmin as any)
            .from("candy_pack_sales")
            .select("transaction_hash, token_mint")
            .in("transaction_hash", slice)
          if (e2) throw new Error(`candy_pack_sales signature read failed: ${e2.message}`)
          for (const r of (s2 ?? []) as Array<{ transaction_hash: string; token_mint: string }>) known.add(`${r.transaction_hash}|${r.token_mint}`)
        }

        // mint → (edition_key, serial) from the ownership cache, batched.
        const mints = [...new Set(cands.map((c) => c.mint))]
        const wmc = new Map<string, { key: string; serial: number | null }>()
        for (let i = 0; i < mints.length; i += 200) {
          const { data, error } = await (supabaseAdmin as any)
            .from("wallet_moments_cache")
            .select("moment_id, edition_key, serial_number")
            .eq("collection_id", CANDY_MLB_UUID)
            .in("moment_id", mints.slice(i, i + 200))
          if (error) throw new Error(`wmc batch lookup failed: ${error.message}`)
          for (const r of (data ?? []) as Array<{ moment_id: string; edition_key: string | null; serial_number: number | null }>) {
            if (r.edition_key && !wmc.has(r.moment_id)) wmc.set(r.moment_id, { key: r.edition_key, serial: r.serial_number })
          }
        }

        let holdSec: number | null = null
        const hold = (c: { sig: string; tSec: number }, reason: string) => {
          skipped++
          bump(reason)
          if (TERMINAL_SKIPS.has(reason) || reason.startsWith("unsupported_currency")) return
          if (stuckMs > HOLD_MAX_DAYS * 86_400_000) {
            abandoned.push({ signature: c.sig, reason })
            return
          }
          holdSec = holdSec == null ? c.tSec : Math.min(holdSec, c.tSec)
        }

        const rows: Record<string, unknown>[] = []
        const rowSec = new Map<Record<string, unknown>, number>()
        const seen = new Set<string>()
        for (const c of cands) {
          const dk = `${c.sig}|${c.mint}`
          if (known.has(dk)) {
            bump("skipped_known_signature")
            continue
          }
          if (seen.has(dk)) continue
          seen.add(dk)
          if (c.e.quantity != null && c.e.quantity !== 1) {
            hold(c, "multi_quantity")
            continue
          }
          const tMs = c.tSec * 1000
          const price = await salePrice(c.e.payment, tMs)
          if ("skip" in price) {
            hold(c, price.skip)
            continue
          }

          let key = wmc.get(c.mint)?.key ?? null
          let serial = wmc.get(c.mint)?.serial ?? null
          if (!key || serial == null) {
            // Unknown to the cache: may be a sealed PACK, or a card the cache has
            // not seen. DAS decides, within a budget.
            if (assetFetches >= ASSET_FETCH_BUDGET) {
              hold(c, "asset_budget_exhausted")
              continue
            }
            let asset
            try {
              asset = await getAsset(c.mint)
              assetFetches++
            } catch {
              hold(c, "das_fetch_failed")
              continue
            }
            if (isPack(asset)) {
              const { error: pe } = await (supabaseAdmin as any)
                .from("candy_pack_sales")
                .upsert(
                  {
                    transaction_hash: c.sig,
                    token_mint: c.mint,
                    collection_id: CANDY_MLB_UUID,
                    serial_number: normalizeSerial(asset).serial_number,
                    price_sol: price.currency === "SOL" ? price.native : null,
                    price_usd: price.usd,
                    buyer: c.e.buyer ?? null,
                    seller: c.e.seller ?? null,
                    sold_at: new Date(tMs).toISOString(),
                  },
                  { onConflict: "transaction_hash,token_mint" },
                )
              if (pe) {
                writeErrors.push(`candy_pack_sales upsert: ${pe.message}`)
                hold(c, "pack_sale_write_failed")
              } else {
                packSalesWritten++
              }
              continue
            }
            key = editionKeyFromAsset(asset) || null
            serial = normalizeSerial(asset).serial_number
            if (!key || serial == null) {
              hold(c, "not_candy")
              continue
            }
          }

          let editionId = editionIdByKey.get(key)
          if (editionId === undefined) {
            const { data: ed, error: edErr } = await (supabaseAdmin as any)
              .from("editions")
              .select("id")
              .eq("collection_id", CANDY_MLB_UUID)
              .eq("external_id", key)
              .limit(1)
            if (edErr) throw new Error(`editions read failed for ${key}: ${edErr.message}`)
            editionId = (ed?.[0]?.id ?? null) as string | null
            editionIdByKey.set(key, editionId)
          }
          if (!editionId) {
            hold(c, "edition_not_ingested")
            continue
          }

          const row = {
            id: crypto.randomUUID(),
            edition_id: editionId,
            collection_id: CANDY_MLB_UUID,
            collection: CANDY_MLB_SLUG,
            nft_id: c.mint,
            serial_number: serial,
            price_usd: price.usd,
            price_native: price.native,
            currency: price.currency,
            marketplace: "opensea",
            source: "opensea_api",
            transaction_hash: c.sig,
            sold_at: new Date(tMs).toISOString(),
            buyer_address: c.e.buyer ?? null,
            seller_address: c.e.seller ?? null,
            ingested_at: new Date().toISOString(),
          }
          rows.push(row)
          rowSec.set(row, c.tSec)
        }

        // Insert; a batch error retries row-by-row so one duplicate (23505)
        // cannot drop its co-batched new sales.
        for (let i = 0; i < rows.length; i += 100) {
          const batch = rows.slice(i, i + 100)
          const { error } = await (supabaseAdmin as any).from("sales").insert(batch)
          if (!error) {
            written += batch.length
            continue
          }
          for (const row of batch) {
            const { error: se } = await (supabaseAdmin as any).from("sales").insert(row)
            if (!se) written++
            else if (se.code === "23505") bump("duplicate_on_insert")
            else {
              writeErrors.push(`sales insert: ${se.message}`)
              hold({ sig: String(row.transaction_hash), tSec: rowSec.get(row) ?? winStart }, "insert_failed")
            }
          }
        }

        // Advance: past the window, or to just before the oldest held sale.
        const nextSec: number = holdSec != null ? Math.max(winStart, (holdSec as number) - 1) : winEnd
        if (nextSec > cursorSec) {
          const { error: cwErr } = await (supabaseAdmin as any)
            .from("event_cursor")
            .upsert({ id: CURSOR_ID, last_processed_block: nextSec, updated_at: new Date().toISOString() }, { onConflict: "id" })
          if (cwErr) throw new Error(`cursor advance failed: ${cwErr.message}`)
          cursorSec = nextSec
          stuckMs = 0
        }
        cursorAfter = isoSec(cursorSec)
        if (holdSec != null) {
          held = true
        } else {
          windowsCompleted++
        }
      }

      cursorAfter = isoSec(cursorSec)
      const ok = writeErrors.length === 0 && !windowTruncated
      await logRun(
        startedAtIso,
        found,
        written,
        skipped,
        ok,
        !ok
          ? (windowTruncated
              ? `a window exceeded ${MAX_PAGES_PER_WINDOW} pages — cursor held at ${cursorAfter}`
              : `${writeErrors.length} rejected write(s): ${writeErrors.slice(0, 3).join(" | ")}`
            ).slice(0, 500)
          : null,
        cursorBefore,
        cursorAfter,
        {
          slug,
          slug_discovery: d.how,
          me_ceiling: meCeilingSec != null ? isoSec(meCeilingSec) : null,
          windows_completed: windowsCompleted,
          held_by_unresolved: held,
          window_truncated: windowTruncated,
          budget_exhausted: budgetExhausted,
          caught_up: !held && !budgetExhausted && !windowTruncated && meCeilingSec != null && cursorSec >= meCeilingSec,
          sales_found: found,
          sales_written: written,
          pack_sales_written: packSalesWritten,
          skip_reasons: counts,
          abandoned_count: abandoned.length,
          abandoned: abandoned.slice(0, 20),
          protocols,
          asset_fetches: assetFetches,
          write_errors: writeErrors.length,
          duration_ms: Date.now() - startedMs,
        },
      )
    } catch (e) {
      await logRun(startedAtIso, found, written, skipped, false, e instanceof Error ? e.message : String(e), cursorBefore, cursorAfter, {
        slug,
        sales_written: written,
        windows_completed: windowsCompleted,
        duration_ms: Date.now() - startedMs,
      })
    }
  })

  return NextResponse.json({ accepted: true, collection: CANDY_MLB_SLUG, started_at: startedAtIso }, { status: 202 })
}
