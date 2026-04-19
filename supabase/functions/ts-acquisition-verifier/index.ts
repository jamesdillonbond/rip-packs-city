// ts-acquisition-verifier — classify inferred_no_signal rows in
// moment_acquisitions for Trevor's Top Shot wallet by scanning on-chain
// Flow events around each row's acquired_date anchor.
//
// The 907 inferred_no_signal rows are acquisitions where Flowty should have
// returned a signal but didn't, so they were defaulted to pack_pull with low
// confidence. Their transaction_hash values are 'seed:<nft_id>' placeholders,
// so lookup-by-tx is not an option — instead we scan a ±6h window of Flow
// blocks for TopShot.Deposit events where the recipient matches the wallet.
// Once a Deposit is located, the full transaction's events are fetched and
// classified:
//   - MomentMinted present           → pack_pull
//   - MomentPurchased / ListingComp. → marketplace (seller from Withdraw)
//   - Withdraw+Deposit only          → gift (source_wallet from Withdraw)
//
// Scope: ONLY inferred_no_signal. The 470 inferred_pre_flowty rows are
// out of scope — pre-2023, overwhelmingly pack pulls, not worth the scan.
//
// Auth: Authorization: Bearer <INGEST_SECRET_TOKEN>  (rippackscity2026)
// Invocation: cron every 20 min. Each run drains 20 NFTs. ~11 day full drain.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0"

// ─── Constants ──────────────────────────────────────────────────────────────

const PUBLIC_FLOW_REST = "https://rest-mainnet.onflow.org"
const FLOW_REST =
  Deno.env.get("FLOW_RPC_URL") ??
  Deno.env.get("QUICKNODE_FLOW_URL") ??
  Deno.env.get("FLOW_ACCESS_URL") ??
  PUBLIC_FLOW_REST

const USING_PUBLIC_ACCESS = FLOW_REST === PUBLIC_FLOW_REST

const TREVOR_WALLET = "0xbd94cade097e50ac"
const TS_COLLECTION_ID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"

// NBA Top Shot contract addresses
const TOPSHOT_DEPOSIT = "A.0b2a3299cc857e29.TopShot.Deposit"
const TOPSHOT_WITHDRAW = "A.0b2a3299cc857e29.TopShot.Withdraw"
const TOPSHOT_MINTED = "A.0b2a3299cc857e29.TopShot.MomentMinted"
const MARKET_V3_PURCHASED = "A.c1e4f4f4c4257510.TopShotMarketV3.MomentPurchased"
const MARKET_LEGACY_PURCHASED = "A.c1e4f4f4c4257510.Market.MomentPurchased"
const STOREFRONT_COMPLETED = "A.4eb8a10cb9f87357.NFTStorefrontV2.ListingCompleted"
const TOPSHOT_NFT_TYPE = "A.0b2a3299cc857e29.TopShot.NFT"

// Flow Access API caps event queries at 250 blocks per request
const BLOCK_CHUNK = 250
// Flow block time ≈ 1.5s. ±6h = ±14400 blocks ≈ ±4 hours of 250-block chunks
const WINDOW_SECONDS = 6 * 3600
// Concurrency for chunk scans per NFT
const CHUNK_CONCURRENCY = USING_PUBLIC_ACCESS ? 2 : 5
// Per-invocation time budget (edge function max wall-clock ≈ 150s)
const BUDGET_MS = 140_000
// Inter-request throttle for the public Access API (2 req/sec sustained)
const THROTTLE_MS = USING_PUBLIC_ACCESS ? 500 : 100

const SUPABASE_URL =
  Deno.env.get("SUPABASE_URL") ?? Deno.env.get("NEXT_PUBLIC_SUPABASE_URL")!
const SERVICE_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SERVICE_ROLE_KEY")!
const INGEST_TOKEN = Deno.env.get("INGEST_SECRET_TOKEN") ?? "rippackscity2026"

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

// ─── Types ──────────────────────────────────────────────────────────────────

interface BatchRow {
  id: string
  nft_id: string
  acquired_date: string
  acquisition_confidence: string
}

interface FlowEvent {
  type: string
  transaction_id: string
  transaction_index: string
  event_index: string
  payload: string
}

interface FlowBlockEvents {
  block_id: string
  block_height: string
  block_timestamp: string
  events: FlowEvent[]
}

interface DecodedPayload {
  id: string
  fields: Array<{ name: string; value: { type: string; value: unknown } }>
}

interface Classification {
  method: "pack_pull" | "marketplace" | "gift"
  source_wallet: string | null
  source_address: string | null
  seller_address: string | null
  pack_dist_id: string | null
  buy_price: number | null
}

// ─── Flow helpers ───────────────────────────────────────────────────────────

let lastRequestAt = 0
async function throttle(): Promise<void> {
  const wait = THROTTLE_MS - (Date.now() - lastRequestAt)
  if (wait > 0) await sleep(wait)
  lastRequestAt = Date.now()
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function flowFetch(url: string, maxRetries = 4): Promise<Response> {
  let delay = 2000
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    await throttle()
    const res = await fetch(url, {
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    })
    if (res.ok) return res
    if (res.status === 429 || res.status >= 500) {
      if (attempt === maxRetries) {
        throw new Error(`Flow HTTP ${res.status} after ${maxRetries + 1} tries: ${url}`)
      }
      await sleep(delay)
      delay *= 2
      continue
    }
    throw new Error(`Flow HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  }
  throw new Error("unreachable")
}

function decodePayload(b64: string): DecodedPayload | null {
  try {
    const bin = atob(b64)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    const json = JSON.parse(new TextDecoder("utf-8").decode(bytes))
    return { id: json.value?.id ?? "", fields: json.value?.fields ?? [] }
  } catch {
    return null
  }
}

// Cadence JSON-CDC values are { type, value }. Optional wraps another value
// (or null). Extract the leaf primitive for a named field.
function getField(fields: DecodedPayload["fields"], name: string): unknown {
  const f = fields.find((x) => x.name === name)
  if (!f) return null
  let v: any = f.value
  while (v && v.type === "Optional") v = v.value
  return v?.value ?? null
}

function normalizeAddress(raw: string | null | undefined): string | null {
  if (!raw) return null
  const hex = String(raw).trim().toLowerCase().replace(/^0x/, "")
  if (!/^[0-9a-f]+$/.test(hex)) return null
  return `0x${hex.padStart(16, "0")}`
}

async function getSealedBlock(): Promise<{ height: number; timestamp: number }> {
  const res = await flowFetch(`${FLOW_REST}/v1/blocks?height=sealed`)
  const json = await res.json()
  const block = Array.isArray(json) ? json[0] : json
  const height = parseInt(block.header.height, 10)
  const timestamp = new Date(block.header.timestamp).getTime()
  return { height, timestamp }
}

// Estimate the Flow block height at a given unix time using a known anchor.
// Flow's target block time is 1.5s; this is a rough estimate but accurate
// enough to center a ±6h window for event scanning.
function estimateHeight(
  targetMs: number,
  anchor: { height: number; timestamp: number },
): number {
  const deltaSeconds = (anchor.timestamp - targetMs) / 1000
  const blocksBack = Math.floor(deltaSeconds / 1.5)
  return Math.max(1, anchor.height - blocksBack)
}

async function fetchEvents(
  eventType: string,
  startHeight: number,
  endHeight: number,
): Promise<FlowBlockEvents[]> {
  const url = `${FLOW_REST}/v1/events?type=${encodeURIComponent(eventType)}&start_height=${startHeight}&end_height=${endHeight}`
  const res = await flowFetch(url)
  const blocks = (await res.json()) as FlowBlockEvents[]
  return Array.isArray(blocks) ? blocks : []
}

async function fetchTransactionResults(txId: string): Promise<FlowEvent[]> {
  const res = await flowFetch(`${FLOW_REST}/v1/transaction_results/${txId}`)
  const json = await res.json()
  return (json?.events ?? []) as FlowEvent[]
}

// ─── Scanning ───────────────────────────────────────────────────────────────

interface DepositHit {
  transactionId: string
  blockHeight: number
  blockTimestamp: string
}

// Scan a ±6h block window for a TopShot.Deposit event matching the wallet
// and the target nft_id. Returns the first hit (chronologically earliest
// is not required — any hit is the acquisition tx).
async function findDepositHit(
  nftId: string,
  startHeight: number,
  endHeight: number,
  deadline: number,
): Promise<DepositHit | null> {
  const ranges: Array<[number, number]> = []
  for (let h = startHeight; h <= endHeight; h += BLOCK_CHUNK) {
    ranges.push([h, Math.min(h + BLOCK_CHUNK - 1, endHeight)])
  }

  // Process ranges in concurrent waves so one slow request doesn't stall.
  const targetWallet = normalizeAddress(TREVOR_WALLET)!
  for (let i = 0; i < ranges.length; i += CHUNK_CONCURRENCY) {
    if (Date.now() > deadline) return null
    const wave = ranges.slice(i, i + CHUNK_CONCURRENCY)
    const results = await Promise.all(
      wave.map(([s, e]) =>
        fetchEvents(TOPSHOT_DEPOSIT, s, e).catch((err) => {
          console.log(`[ts-verify] events ${s}-${e} err:`, (err as Error).message)
          return [] as FlowBlockEvents[]
        }),
      ),
    )
    for (const blocks of results) {
      for (const block of blocks) {
        for (const ev of block.events) {
          const payload = decodePayload(ev.payload)
          if (!payload) continue
          const evNftId = String(getField(payload.fields, "id") ?? "")
          if (evNftId !== nftId) continue
          const to = normalizeAddress(getField(payload.fields, "to") as string)
          if (to !== targetWallet) continue
          return {
            transactionId: ev.transaction_id,
            blockHeight: parseInt(block.block_height, 10),
            blockTimestamp: block.block_timestamp,
          }
        }
      }
    }
  }
  return null
}

// Classify an acquisition from the enclosing transaction's events.
function classifyFromTx(events: FlowEvent[], nftId: string): Classification {
  const decoded = events.map((ev) => ({ type: ev.type, p: decodePayload(ev.payload) }))

  const hasMint = decoded.some(
    (d) =>
      d.type === TOPSHOT_MINTED &&
      String(getField(d.p?.fields ?? [], "momentID") ?? getField(d.p?.fields ?? [], "id") ?? "") === nftId,
  )
  if (hasMint) {
    return {
      method: "pack_pull",
      source_wallet: null,
      source_address: null,
      seller_address: null,
      pack_dist_id: null,
      buy_price: null,
    }
  }

  // Marketplace: TopShotMarketV3.MomentPurchased (id, price, seller)
  for (const d of decoded) {
    if (d.type !== MARKET_V3_PURCHASED && d.type !== MARKET_LEGACY_PURCHASED) continue
    if (!d.p) continue
    const evId = String(getField(d.p.fields, "id") ?? "")
    if (evId !== nftId) continue
    const priceRaw = getField(d.p.fields, "price")
    const price = priceRaw != null ? Number(priceRaw) : null
    const seller = normalizeAddress(getField(d.p.fields, "seller") as string)
    return {
      method: "marketplace",
      source_wallet: seller,
      source_address: seller,
      seller_address: seller,
      pack_dist_id: null,
      buy_price: price && !Number.isNaN(price) ? price : null,
    }
  }

  // Marketplace: NFTStorefrontV2.ListingCompleted (purchased, nftType, nftID, salePrice, storefrontAddress)
  for (const d of decoded) {
    if (d.type !== STOREFRONT_COMPLETED) continue
    if (!d.p) continue
    const purchased = getField(d.p.fields, "purchased")
    if (purchased !== true) continue
    const nftType = String(getField(d.p.fields, "nftType") ?? "")
    if (!nftType.includes(TOPSHOT_NFT_TYPE)) continue
    const evNftId = String(getField(d.p.fields, "nftID") ?? "")
    if (evNftId !== nftId) continue
    const priceRaw = getField(d.p.fields, "salePrice")
    const price = priceRaw != null ? Number(priceRaw) : null
    const seller = normalizeAddress(getField(d.p.fields, "storefrontAddress") as string)
    return {
      method: "marketplace",
      source_wallet: seller,
      source_address: seller,
      seller_address: seller,
      pack_dist_id: null,
      buy_price: price && !Number.isNaN(price) ? price : null,
    }
  }

  // Gift / transfer: Withdraw → Deposit pair with no mint or purchase.
  for (const d of decoded) {
    if (d.type !== TOPSHOT_WITHDRAW) continue
    if (!d.p) continue
    const evNftId = String(getField(d.p.fields, "id") ?? "")
    if (evNftId !== nftId) continue
    const from = normalizeAddress(getField(d.p.fields, "from") as string)
    return {
      method: "gift",
      source_wallet: from,
      source_address: from,
      seller_address: null,
      pack_dist_id: null,
      buy_price: null,
    }
  }

  // Last resort: no classifying event found. Treat as gift with unknown source.
  return {
    method: "gift",
    source_wallet: null,
    source_address: null,
    seller_address: null,
    pack_dist_id: null,
    buy_price: null,
  }
}

// ─── Main drain ─────────────────────────────────────────────────────────────

async function drain(requestId: string): Promise<void> {
  const started = Date.now()
  const deadline = started + BUDGET_MS

  let counts = { resolved: 0, failed: 0, pack_pull: 0, marketplace: 0, gift: 0 }

  try {
    const { data: batchData, error: batchErr } = await (supabase as any).rpc(
      "acq_get_inferred_batch",
      {
        p_wallet: TREVOR_WALLET,
        p_collection_id: TS_COLLECTION_ID,
        p_limit: 20,
        p_offset: 0,
      },
    )
    if (batchErr) {
      console.log(`[ts-verify ${requestId}] batch rpc err:`, batchErr.message)
      return
    }
    const batch = (batchData ?? []) as BatchRow[]
    // Hard-filter to inferred_no_signal — never touch inferred_pre_flowty.
    const rows = batch.filter((r) => r.acquisition_confidence === "inferred_no_signal")

    if (rows.length === 0) {
      console.log(`[ts-verify ${requestId}] no inferred_no_signal rows to process`)
      return
    }

    const anchor = await getSealedBlock()
    console.log(
      `[ts-verify ${requestId}] batch=${rows.length} flow_rpc=${USING_PUBLIC_ACCESS ? "public" : "private"} sealed=${anchor.height}`,
    )

    for (const row of rows) {
      if (Date.now() > deadline) {
        console.log(`[ts-verify ${requestId}] time budget exhausted, stopping`)
        break
      }

      const acquiredMs = new Date(row.acquired_date).getTime()
      if (!Number.isFinite(acquiredMs)) {
        counts.failed++
        continue
      }

      const center = estimateHeight(acquiredMs, anchor)
      const halfBlocks = Math.ceil(WINDOW_SECONDS / 1.5)
      const startHeight = Math.max(1, center - halfBlocks)
      const endHeight = Math.min(anchor.height, center + halfBlocks)

      let hit: DepositHit | null = null
      try {
        hit = await findDepositHit(row.nft_id, startHeight, endHeight, deadline)
      } catch (err) {
        console.log(
          `[ts-verify ${requestId}] nft=${row.nft_id} scan err:`,
          (err as Error).message,
        )
      }

      if (!hit) {
        counts.failed++
        continue
      }

      let txEvents: FlowEvent[] = []
      try {
        txEvents = await fetchTransactionResults(hit.transactionId)
      } catch (err) {
        console.log(
          `[ts-verify ${requestId}] nft=${row.nft_id} tx=${hit.transactionId} err:`,
          (err as Error).message,
        )
        counts.failed++
        continue
      }

      const cls = classifyFromTx(txEvents, row.nft_id)

      const { error: verifyErr } = await (supabase as any).rpc(
        "acq_verify_from_chain",
        {
          p_id: row.id,
          p_method: cls.method,
          p_source_wallet: cls.source_wallet,
          p_source_address: cls.source_address,
          p_seller_address: cls.seller_address,
          p_pack_dist_id: cls.pack_dist_id,
          p_buy_price: cls.buy_price,
        },
      )

      if (verifyErr) {
        console.log(
          `[ts-verify ${requestId}] nft=${row.nft_id} rpc err:`,
          verifyErr.message,
        )
        counts.failed++
        continue
      }

      counts.resolved++
      counts[cls.method]++
    }
  } catch (err) {
    console.log(`[ts-verify ${requestId}] fatal:`, (err as Error).message)
  } finally {
    const elapsed = Date.now() - started
    console.log(
      `[ts-verify ${requestId}] done elapsed=${elapsed}ms resolved=${counts.resolved} failed=${counts.failed} pack_pull=${counts.pack_pull} marketplace=${counts.marketplace} gift=${counts.gift}`,
    )
  }
}

// ─── Entry ──────────────────────────────────────────────────────────────────

Deno.serve((req: Request) => {
  const auth = req.headers.get("Authorization") ?? ""
  const bearer = auth.replace(/^Bearer\s+/i, "")
  const url = new URL(req.url)
  const urlToken = url.searchParams.get("token") ?? ""
  if (bearer !== INGEST_TOKEN && urlToken !== INGEST_TOKEN) {
    return new Response("Unauthorized", { status: 401 })
  }

  const requestId = crypto.randomUUID().slice(0, 8)

  // Fire-and-forget: the event scan comfortably exceeds the 30s HTTP response
  // envelope, so kick the drain into the background and return immediately.
  // EdgeRuntime.waitUntil keeps the worker alive until the promise settles.
  const drainPromise = drain(requestId)
  try {
    // @ts-ignore — EdgeRuntime is provided by the Supabase edge runtime
    if (typeof EdgeRuntime !== "undefined" && EdgeRuntime?.waitUntil) {
      // @ts-ignore
      EdgeRuntime.waitUntil(drainPromise)
    }
  } catch (err) {
    console.log("[ts-verify] waitUntil err:", (err as Error).message)
  }

  return new Response(
    JSON.stringify({
      ok: true,
      request_id: requestId,
      wallet: TREVOR_WALLET,
      batch_size: 20,
      note: "drain running in background; see function logs for counts",
    }),
    { headers: { "Content-Type": "application/json; charset=utf-8" } },
  )
})
