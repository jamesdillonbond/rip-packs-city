import { NextRequest, NextResponse, after } from "next/server"
import { supabaseAdmin } from "@/lib/supabase"

// ── AllDay buyer-resolve cron endpoint ──────────────────────────────────────
//
// The inline Cadence resolution in the AllDay sales indexer has a 0% hit rate
// because AllDay NFTs transfer out of Flowty escrow immediately after purchase,
// so a borrow against the seller/escrow returns nothing. This route re-walks
// unmapped_sales and resolves the real buyer by pulling proposer/authorizer/
// payer from the tx envelope via Flow REST, buckets nft_ids per buyer, then
// borrows editionID + serialNumber off the buyer's own collection. Matches
// are upserted into nft_edition_map and promote_unmapped_sales is called to
// flip resolved rows into sales (+ trigger fmv_from_sales).
//
// Ported from scripts/resolve-allday-buyers.ts. Difference: no backfill_state
// cursor — `resolved_at IS NULL` is the natural filter, and we take the oldest
// BATCH_CAP rows each invocation. A 30-second Vercel fn is enough for ~100
// rows (sub-second tx fetches, sub-second borrow per bucket).
//
// Cron: hourly at :30 via cron-job.org.
// ─────────────────────────────────────────────────────────────────────────────

export const maxDuration = 60

const PIPELINE_NAME = "resolve-allday-buyers"
const ALLDAY_COLLECTION_ID = "dee28451-5d62-409e-a1ad-a83f763ac070"
const FLOW_REST = "https://rest-mainnet.onflow.org"
const BATCH_CAP = 100
const TX_FETCH_CONCURRENCY = 8

// Addresses that always appear in the Flowty purchase envelope but are never
// the buyer. Case-insensitive 0x-normalised.
const EXCLUDED_ADDRESSES = new Set<string>([
  "0x3cdbb3d569211ff3", // Flowty storefront escrow / seller
  "0x18eb4ee6b3c026d2", // Flowty fee payer
  "0xead892083b3e2c6c", // Dapper DUC co-signer
])

const BORROW_SCRIPT = `
import AllDay from 0xe4cf4bdc1751c65d
import NonFungibleToken from 0x1d7e57aa55817448

access(all) fun main(owners: [Address], ids: [UInt64]): {UInt64: [UInt64]} {
  let out: {UInt64: [UInt64]} = {}
  for id in ids {
    for owner in owners {
      let ref = getAccount(owner).capabilities
        .borrow<&{NonFungibleToken.Collection}>(/public/AllDayNFTCollection)
      if ref == nil { continue }
      let nft = ref!.borrowNFT(id)
      if nft == nil { continue }
      let ad = nft! as! &AllDay.NFT
      out[id] = [ad.editionID, ad.serialNumber]
      break
    }
  }
  return out
}
`.trim()

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function normalizeAddress(raw: string): string {
  const hex = raw.trim().toLowerCase().replace(/^0x/, "")
  return `0x${hex.padStart(16, "0")}`
}

interface UnmappedRow {
  id: string
  nft_id: string
  transaction_hash: string
}

interface FlowTxResponse {
  proposal_key?: { address?: string }
  authorizers?: string[]
  payer?: string
}

async function fetchTxBuyers(txHash: string): Promise<string[]> {
  const clean = txHash.replace(/^0x/, "")
  const res = await fetch(`${FLOW_REST}/v1/transactions/${clean}`, {
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) {
    if (res.status === 404) return []
    throw new Error(`tx ${clean} HTTP ${res.status}`)
  }
  const j = (await res.json()) as FlowTxResponse
  const candidates = new Set<string>()
  if (j.proposal_key?.address) candidates.add(normalizeAddress(j.proposal_key.address))
  for (const a of j.authorizers ?? []) candidates.add(normalizeAddress(a))
  if (j.payer) candidates.add(normalizeAddress(j.payer))
  return Array.from(candidates).filter((a) => !EXCLUDED_ADDRESSES.has(a))
}

interface CdcValue {
  type: string
  value: unknown
}
interface CdcKeyValue {
  key: CdcValue
  value: CdcValue
}

async function runBorrowScript(
  owners: string[],
  ids: string[]
): Promise<Map<string, { editionID: string; serialNumber: string }>> {
  const body = {
    script: Buffer.from(BORROW_SCRIPT, "utf8").toString("base64"),
    arguments: [
      Buffer.from(
        JSON.stringify({
          type: "Array",
          value: owners.map((a) => ({ type: "Address", value: a })),
        })
      ).toString("base64"),
      Buffer.from(
        JSON.stringify({
          type: "Array",
          value: ids.map((v) => ({ type: "UInt64", value: v })),
        })
      ).toString("base64"),
    ],
  }

  const res = await fetch(`${FLOW_REST}/v1/scripts?block_height=sealed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`script HTTP ${res.status}: ${text.slice(0, 200)}`)
  }

  const raw = (await res.text()).trim().replace(/^"|"$/g, "")
  const decoded = JSON.parse(Buffer.from(raw, "base64").toString("utf8")) as CdcValue
  const out = new Map<string, { editionID: string; serialNumber: string }>()
  const entries = (decoded?.value as CdcKeyValue[] | undefined) ?? []
  for (const entry of entries) {
    const nftId = String(entry.key?.value ?? "")
    const arr = (entry.value?.value as CdcValue[] | undefined) ?? []
    if (!nftId || arr.length < 2) continue
    const editionID = String(arr[0]?.value ?? "")
    const serialNumber = String(arr[1]?.value ?? "")
    if (!editionID) continue
    out.set(nftId, { editionID, serialNumber })
  }
  return out
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let nextIndex = 0
  async function runWorker() {
    while (true) {
      const currentIndex = nextIndex++
      if (currentIndex >= items.length) return
      results[currentIndex] = await worker(items[currentIndex], currentIndex)
    }
  }
  await Promise.all(
    Array.from(
      { length: Math.max(1, Math.min(concurrency, items.length)) },
      () => runWorker()
    )
  )
  return results
}

export async function GET(req: NextRequest) {
  const queryToken = req.nextUrl.searchParams.get("token")
  const authHeader = req.headers.get("authorization") ?? ""
  const bearerToken = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7).trim()
    : null
  const token = queryToken || bearerToken

  if (!token || token !== process.env.INGEST_SECRET_TOKEN) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 })
  }

  after(async () => {
    const startedAt = new Date().toISOString()
    const start = Date.now()
    let ok = true
    let errorMsg: string | null = null
    let rowsFound = 0
    let rowsWritten = 0
    let rowsSkipped = 0
    let txFetched = 0
    let txFailed = 0
    let borrowMiss = 0
    let promoteResult: unknown = null

    try {
      // 1. Load oldest unresolved AllDay rows (resolved_at IS NULL is the
      //    natural filter — no cursor needed).
      const { data, error } = await (supabaseAdmin as any)
        .from("unmapped_sales")
        .select("id,nft_id,transaction_hash")
        .eq("collection_id", ALLDAY_COLLECTION_ID)
        .is("resolved_at", null)
        .not("transaction_hash", "is", null)
        .order("id", { ascending: true })
        .limit(BATCH_CAP)

      if (error) throw new Error(`unmapped_sales query: ${error.message}`)

      const rows = ((data as UnmappedRow[] | null) ?? []).filter(
        (r) => r.nft_id && r.transaction_hash
      )
      rowsFound = rows.length

      if (rows.length === 0) {
        console.log(`[${PIPELINE_NAME}] no unresolved rows — exiting`)
        return
      }

      console.log(`[${PIPELINE_NAME}] processing ${rows.length} unresolved rows`)

      // 2. Parallel tx fetches → ownersByNft map.
      const ownersByNft = new Map<string, string[]>()
      await mapWithConcurrency(rows, TX_FETCH_CONCURRENCY, async (r) => {
        try {
          const owners = await fetchTxBuyers(r.transaction_hash)
          ownersByNft.set(r.nft_id, owners)
          txFetched++
        } catch (e) {
          txFailed++
          console.log(
            `[${PIPELINE_NAME}] tx ${r.transaction_hash.slice(0, 10)} err: ${
              e instanceof Error ? e.message : String(e)
            }`
          )
        }
      })

      // 3. Bucket nft_ids by owner address.
      const bucketsByOwner = new Map<string, Set<string>>()
      for (const r of rows) {
        const owners = ownersByNft.get(r.nft_id) ?? []
        for (const o of owners) {
          let set = bucketsByOwner.get(o)
          if (!set) {
            set = new Set<string>()
            bucketsByOwner.set(o, set)
          }
          set.add(r.nft_id)
        }
      }

      // 4. Borrow script per bucket.
      const resolved = new Map<
        string,
        { editionID: string; serialNumber: string }
      >()
      for (const [owner, idSet] of bucketsByOwner) {
        const ids = Array.from(idSet).filter((id) => !resolved.has(id))
        if (ids.length === 0) continue
        try {
          const matches = await runBorrowScript([owner], ids)
          for (const [id, v] of matches) resolved.set(id, v)
        } catch (e) {
          console.log(
            `[${PIPELINE_NAME}] borrow err owner=${owner} ids=${ids.length}: ${
              e instanceof Error ? e.message : String(e)
            }`
          )
        }
        await sleep(150)
      }

      // 5. Upsert into nft_edition_map.
      const upsertRows: Array<{
        collection_id: string
        nft_id: string
        edition_external_id: string
        serial_number: number
      }> = []
      for (const r of rows) {
        const hit = resolved.get(r.nft_id)
        if (!hit) {
          if ((ownersByNft.get(r.nft_id) ?? []).length > 0) borrowMiss++
          else rowsSkipped++
          continue
        }
        const serial = Number(hit.serialNumber)
        upsertRows.push({
          collection_id: ALLDAY_COLLECTION_ID,
          nft_id: r.nft_id,
          edition_external_id: hit.editionID,
          serial_number: Number.isFinite(serial) ? serial : 0,
        })
      }

      if (upsertRows.length > 0) {
        const { error: upsertErr } = await (supabaseAdmin as any)
          .from("nft_edition_map")
          .upsert(upsertRows, {
            onConflict: "collection_id,nft_id",
            ignoreDuplicates: true,
          })
        if (upsertErr) {
          console.log(`[${PIPELINE_NAME}] upsert err: ${upsertErr.message}`)
        } else {
          rowsWritten = upsertRows.length
        }
      }

      // 6. Promote the resolved rows → triggers fmv_from_sales.
      try {
        const { data: promoted, error: promoteErr } = await (
          supabaseAdmin as any
        ).rpc("promote_unmapped_sales", { p_collection_id: ALLDAY_COLLECTION_ID })
        if (promoteErr) {
          console.log(`[${PIPELINE_NAME}] promote err: ${promoteErr.message}`)
        } else {
          promoteResult = promoted
        }
      } catch (e) {
        console.log(
          `[${PIPELINE_NAME}] promote exception: ${
            e instanceof Error ? e.message : String(e)
          }`
        )
      }

      console.log(
        `[${PIPELINE_NAME}] done rows=${rows.length} tx=${txFetched}/${
          txFetched + txFailed
        } resolved=${upsertRows.length} borrow_miss=${borrowMiss} skipped=${rowsSkipped}`
      )
    } catch (err) {
      ok = false
      errorMsg = err instanceof Error ? err.message : String(err)
      console.log(`[${PIPELINE_NAME}] fatal: ${errorMsg}`)
    } finally {
      try {
        await (supabaseAdmin as any).rpc("log_pipeline_run", {
          p_pipeline: PIPELINE_NAME,
          p_started_at: startedAt,
          p_rows_found: rowsFound,
          p_rows_written: rowsWritten,
          p_rows_skipped: rowsSkipped,
          p_ok: ok,
          p_error: errorMsg,
          p_collection_slug: "nfl_all_day",
          p_cursor_before: null,
          p_cursor_after: null,
          p_extra: {
            tx_fetched: txFetched,
            tx_failed: txFailed,
            borrow_miss: borrowMiss,
            promote_result: promoteResult,
            duration_ms: Date.now() - start,
          },
        })
      } catch (e) {
        console.log(
          `[${PIPELINE_NAME}] log_pipeline_run err: ${
            e instanceof Error ? e.message : String(e)
          }`
        )
      }
    }
  })

  return NextResponse.json(
    { accepted: true, started_at: new Date().toISOString() },
    { status: 202 }
  )
}
