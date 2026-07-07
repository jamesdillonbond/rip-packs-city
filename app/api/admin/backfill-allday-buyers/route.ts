import { NextRequest, NextResponse, after } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"
import { decodeV1SaleTx } from "@/lib/chains/flow/dapper-v1-tx-decode"

// POST /api/admin/backfill-allday-buyers — Authorization: Bearer $INGEST_SECRET_TOKEN
//   (or Bearer $CRON_SECRET for the Vercel cron, or ?token=$INGEST_SECRET_TOKEN)
//
// BUILD 1 (greenlit 2026-07-02, docs/handoff-2026-07-02-BUILD-greenlit.md).
// AllDay historical sales were indexed with an unresolved buyer for a large slice
// of history — either NULL, or the Flowty-router escrow 0x3cdbb3d569211ff3 (the V2
// Flowty-fork fee router, never the real buyer). This route drains that backlog:
// for each unresolved-buyer AllDay sale it fetches the on-chain transaction once
// and recovers the real buyer + seller, the same decode the forward
// allday-sales-indexer runs (AllDay.Deposit.to = the moment's recipient = the
// buyer; A.e4cf4bdc1751c65d).
//
// Primary: decodeV1SaleTx pulls AllDay.Deposit.to matching the sale's nft_id.
// Fallback (V2 Flowty-fork envelopes where Deposit.to is the escrow): the tx's
// proposer/authorizers/payer minus the known intermediaries — used ONLY when it
// resolves to exactly one candidate (never guessed).
//
// Resumable + idempotent: walks sold_at DESCENDING via a cursor in
// pipeline_runs.extra->>cursor_sold_at (recent + high-value first, then walks
// back on wrap). Every UPDATE is gated on the buyer still being unresolved, so
// re-runs are safe. Old-spork txs (pre current-spork) return no events and stay
// unresolved — retried on the next top-down pass. Fully reversible: each write's
// before-state is captured in audit_20260706_allday_buyer_backfill.
//
// ?collection=golazos parameterizes the same decode for the Golazos "— —" buyer
// tail (contract 0x87ca73a41bb50ad5); default is AllDay.

const TOKEN = process.env.INGEST_SECRET_TOKEN ?? ""
const CRON = process.env.CRON_SECRET ?? ""

export const dynamic = "force-dynamic"
// 800 = the Pro Lambda HARD cap (over 800 silently ERRORs the deploy). BATCH +
// MAX_RUN_MS bound the actual runtime well under it; this is insurance only.
export const maxDuration = 800

const BATCH = 120
const TX_DECODE_DELAY_MS = 40
// Wall-clock self-bound: stop enqueuing new decodes past this so a batch/latency
// drift can never approach the Lambda cap (a run past the cap dies BEFORE the
// finally block writes its pipeline_runs row — the invisible-failure class). The
// cursor advances only to the oldest row actually processed, so bailing skips
// nothing.
const MAX_RUN_MS = 600_000

const FLOW_REST = "https://rest-mainnet.onflow.org"

// Addresses that appear in an AllDay/Golazos purchase envelope but are never the
// real buyer (Flowty escrow/fee, Dapper DUC co-signer, the Dapper trade contract,
// the storefront escrow). Compared case-insensitively as 0x + bare hex.
const EXCLUDED_ADDRESSES = new Set<string>([
  "0x3cdbb3d569211ff3", // Flowty storefront escrow / fee router
  "0x18eb4ee6b3c026d2", // storefront escrow / Flowty fee payer
  "0xead892083b3e2c6c", // Dapper DUC co-signer
  "0xedf9df96c92f4595", // AllDay/Golazos/UFC Dapper trade contract
])

interface CollectionConfig {
  slug: string
  collectionId: string
  collectionLong: string
  depositEvent: string
  withdrawEvent: string
  pipeline: string
}

const COLLECTIONS: Record<string, CollectionConfig> = {
  allday: {
    slug: "nfl-all-day",
    collectionId: "dee28451-5d62-409e-a1ad-a83f763ac070",
    collectionLong: "nfl_all_day",
    depositEvent: "A.e4cf4bdc1751c65d.AllDay.Deposit",
    withdrawEvent: "A.e4cf4bdc1751c65d.AllDay.Withdraw",
    pipeline: "allday-buyer-backfill",
  },
  golazos: {
    slug: "laliga-golazos",
    collectionId: "06248cc4-b85f-47cd-af67-1855d14acd75",
    collectionLong: "laliga_golazos",
    depositEvent: "A.87ca73a41bb50ad5.Golazos.Deposit",
    withdrawEvent: "A.87ca73a41bb50ad5.Golazos.Withdraw",
    pipeline: "golazos-buyer-backfill",
  },
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

function normalizeAddress(raw: string): string {
  const hex = raw.trim().toLowerCase().replace(/^0x/, "")
  return `0x${hex}`
}

// V2 Flowty-fork fallback: the tx's proposer/authorizers/payer minus the known
// intermediaries. Only unambiguous (exactly-one-candidate) results are used.
async function fetchTxAuthorizers(txHash: string): Promise<string[]> {
  const clean = txHash.replace(/^0x/, "")
  const res = await fetch(`${FLOW_REST}/v1/transactions/${clean}`, {
    signal: AbortSignal.timeout(8000),
  })
  if (!res.ok) return []
  const j = (await res.json()) as {
    proposal_key?: { address?: string }
    authorizers?: string[]
    payer?: string
  }
  const candidates = new Set<string>()
  if (j.proposal_key?.address) candidates.add(normalizeAddress(j.proposal_key.address))
  for (const a of j.authorizers ?? []) candidates.add(normalizeAddress(a))
  if (j.payer) candidates.add(normalizeAddress(j.payer))
  return Array.from(candidates).filter((a) => !EXCLUDED_ADDRESSES.has(a))
}

interface UnresolvedRow {
  id: string
  nft_id: string
  transaction_hash: string
  sold_at: string
  buyer_address: string | null
  seller_address: string | null
}

async function handle(req: NextRequest) {
  const auth = req.headers.get("authorization") ?? ""
  const bearer = auth.replace(/^Bearer\s+/i, "")
  const urlToken = req.nextUrl.searchParams.get("token") ?? ""
  const okAuth =
    (TOKEN && (bearer === TOKEN || urlToken === TOKEN)) || (CRON && bearer === CRON)
  if (!okAuth) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const cfgKey = (req.nextUrl.searchParams.get("collection") ?? "allday").toLowerCase()
  const cfg = COLLECTIONS[cfgKey]
  if (!cfg) {
    return NextResponse.json(
      { error: `unknown collection '${cfgKey}' (expected: ${Object.keys(COLLECTIONS).join(", ")})` },
      { status: 400 },
    )
  }

  const startedAtIso = new Date().toISOString()
  const startedAt = Date.now()

  // Re-resolve predicate: buyer is NULL or one of the never-a-real-buyer intermediaries.
  const orFilter =
    "buyer_address.is.null," + Array.from(EXCLUDED_ADDRESSES).map((a) => `buyer_address.eq.${a}`).join(",")

  after(async () => {
    let cursorBefore: string | null = null
    let cursorAfter: string | null = null
    let found = 0
    let buyersResolved = 0
    let sellersFilled = 0
    let viaDeposit = 0
    let viaAuthorizers = 0
    let decodeFailed = 0
    let bailedEarly = false
    let ok = true
    let errMsg: string | null = null

    try {
      const { data: lastRun } = await (supabaseAdmin as any)
        .from("pipeline_runs")
        .select("extra")
        .eq("pipeline", cfg.pipeline)
        .order("started_at", { ascending: false })
        .limit(1)
        .maybeSingle()
      cursorBefore =
        (lastRun?.extra && typeof lastRun.extra.cursor_sold_at === "string"
          ? lastRun.extra.cursor_sold_at
          : null) ?? null

      let q = (supabaseAdmin as any)
        .from("sales")
        .select("id, nft_id, transaction_hash, sold_at, buyer_address, seller_address")
        .eq("collection", cfg.collectionLong)
        .or(orFilter)
        .not("transaction_hash", "is", null)
        .order("sold_at", { ascending: false })
        .limit(BATCH)
      if (cursorBefore) q = q.lt("sold_at", cursorBefore)

      const { data, error } = await q
      if (error) {
        ok = false
        errMsg = error.message
        console.log(`[backfill-allday-buyers:${cfgKey}] select err: ${error.message}`)
        return
      }
      const rows = (data ?? []) as UnresolvedRow[]
      found = rows.length

      const auditRows: any[] = []
      let minSoldAt: string | null = null

      for (const row of rows) {
        if (Date.now() - startedAt > MAX_RUN_MS) { bailedEarly = true; break }
        if (minSoldAt === null || row.sold_at < minSoldAt) minSoldAt = row.sold_at

        try {
          // Primary: AllDay/Golazos.Deposit.to matching this nft_id.
          const dec = await decodeV1SaleTx(String(row.transaction_hash), {
            depositEventType: cfg.depositEvent,
            withdrawEventType: cfg.withdrawEvent,
            nftId: String(row.nft_id),
          })

          let buyer: string | null = null
          let method = ""
          if (dec.buyer) {
            const b = normalizeAddress(dec.buyer)
            if (!EXCLUDED_ADDRESSES.has(b)) { buyer = b; method = "deposit_to" }
          }
          // Fallback: V2 Flowty-fork — tx authorizers, only if unambiguous.
          if (!buyer) {
            const cands = await fetchTxAuthorizers(String(row.transaction_hash))
            if (cands.length === 1) { buyer = cands[0]; method = "tx_authorizers" }
          }

          const seller =
            !row.seller_address && dec.seller && !EXCLUDED_ADDRESSES.has(normalizeAddress(dec.seller))
              ? normalizeAddress(dec.seller)
              : null

          if (!buyer && !seller) {
            decodeFailed++
          } else {
            const patch: Record<string, unknown> = {}
            if (buyer) patch.buyer_address = buyer
            if (seller) patch.seller_address = seller
            const { error: upErr } = await (supabaseAdmin as any)
              .from("sales")
              .update(patch)
              .eq("id", row.id)
              .or(orFilter)
            if (upErr) {
              console.log(`[backfill-allday-buyers:${cfgKey}] update err id=${row.id}: ${upErr.message}`)
            } else {
              if (buyer) {
                buyersResolved++
                if (method === "deposit_to") viaDeposit++
                else viaAuthorizers++
                auditRows.push({
                  sale_id: row.id,
                  collection_slug: cfg.slug,
                  nft_id: String(row.nft_id),
                  transaction_hash: String(row.transaction_hash),
                  old_buyer_address: row.buyer_address,
                  new_buyer_address: buyer,
                  method,
                })
              }
              if (seller) sellersFilled++
            }
          }
        } catch (err) {
          decodeFailed++
          console.log(
            `[backfill-allday-buyers:${cfgKey}] decode err tx=${row.transaction_hash}: ${err instanceof Error ? err.message : String(err)}`,
          )
        }
        await delay(TX_DECODE_DELAY_MS)
      }

      if (auditRows.length > 0) {
        const { error: aErr } = await (supabaseAdmin as any)
          .from("audit_20260706_allday_buyer_backfill")
          .upsert(auditRows, { onConflict: "sale_id", ignoreDuplicates: true })
        if (aErr) console.log(`[backfill-allday-buyers:${cfgKey}] audit insert err: ${aErr.message}`)
      }

      // Short batch ⇒ bottom of the unresolved set for this pass; wrap the cursor
      // so the next run starts a fresh top-down sweep (retries old-spork misses).
      cursorAfter = rows.length < BATCH ? null : minSoldAt
    } catch (err) {
      ok = false
      errMsg = err instanceof Error ? err.message : String(err)
      console.log(`[backfill-allday-buyers:${cfgKey}] fatal: ${errMsg}`)
    } finally {
      try {
        await (supabaseAdmin as any).from("pipeline_runs").insert({
          pipeline: cfg.pipeline,
          collection_slug: cfg.slug,
          started_at: startedAtIso,
          finished_at: new Date().toISOString(),
          rows_found: found,
          rows_written: buyersResolved,
          rows_skipped: decodeFailed,
          ok,
          error: errMsg ? errMsg.slice(0, 500) : null,
          extra: {
            cursor_sold_at: cursorAfter,
            cursor_before: cursorBefore,
            buyers_resolved: buyersResolved,
            sellers_filled: sellersFilled,
            via_deposit_to: viaDeposit,
            via_tx_authorizers: viaAuthorizers,
            decode_failed: decodeFailed,
            wrapped: cursorAfter === null,
            bailed_early: bailedEarly,
            duration_ms: Date.now() - startedAt,
          },
        })
      } catch (logErr) {
        console.log(
          `[backfill-allday-buyers:${cfgKey}] pipeline_runs insert threw: ${logErr instanceof Error ? logErr.message : String(logErr)}`,
        )
      }
      console.log(
        `[backfill-allday-buyers:${cfgKey}] done found=${found} buyers=${buyersResolved} (deposit=${viaDeposit} authz=${viaAuthorizers}) sellers=${sellersFilled} failed=${decodeFailed} cursorAfter=${cursorAfter}`,
      )
    }
  })

  return NextResponse.json({
    ok: true,
    queued: true,
    collection: cfgKey,
    note: `${cfg.pipeline} queued; progress in pipeline_runs (${cfg.pipeline}).`,
  })
}

// Vercel cron fires a GET with Bearer $CRON_SECRET; admin/cron-job.org can POST
// with Bearer $INGEST_SECRET_TOKEN. Both routes share the same handler.
export async function GET(req: NextRequest) {
  return handle(req)
}
export async function POST(req: NextRequest) {
  return handle(req)
}
