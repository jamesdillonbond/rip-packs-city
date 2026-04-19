// pinnacle-owner-discovery — backward scanner for Pinnacle Deposit events.
//
// The Pinnacle sales indexer can't capture buyer/seller addresses (the
// NFTStorefrontV2 payload only exposes the commission receiver, which for
// Pinnacle is the contract itself). This function closes that gap by
// walking A.edf9df96c92f4595.Pinnacle.Deposit events *backward* from the
// current Flow sealed head, so the first Deposit we observe for any given
// nft_id is its most-recent ownership event. Those (nft_id → owner) pairs
// are upserted into pinnacle_ownership_snapshots with ON CONFLICT DO NOTHING,
// giving the companion pinnacle-nft-resolver function enough context to
// borrow the NFT and reconstruct its edition_key.
//
// Flow Access API constraints:
//   • /v1/events is capped at 250 blocks per call.
//   • We scan BLOCKS_PER_RUN (default 2000) blocks per invocation, which is
//     8 Access API calls — comfortably within edge-function budgets.
//
// Progress state lives in flow_backfill_progress.id = 'pinnacle-deposit-scan'
// (seeded by the migration). `last_processed_height` here represents the
// oldest block we've scanned — when it reaches 0 we've run out of history.
// On the very first run we seed it to the current sealed head.
//
// Auth: Bearer rippackscity2026 (matches the rest of the RPC infra).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0"

const FLOW_REST = "https://rest-mainnet.onflow.org"
const DEPOSIT_EVENT = "A.edf9df96c92f4595.Pinnacle.Deposit"
const CHUNK_SIZE = 250
const DEFAULT_BLOCKS_PER_RUN = 2000
const INTER_CHUNK_DELAY_MS = 100
const SCAN_STATE_ID = "pinnacle-deposit-scan"

const SUPABASE_URL =
  Deno.env.get("SUPABASE_URL") ?? Deno.env.get("NEXT_PUBLIC_SUPABASE_URL") ?? ""
const SERVICE_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? Deno.env.get("SERVICE_ROLE_KEY") ?? ""

const supabase = createClient(SUPABASE_URL, SERVICE_KEY)

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

// Cadence JSON → plain JS. Lifted from pinnacle-sales-indexer; handles
// Optional / Array / Dictionary / Struct / Event / Resource wrappers.
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
        const fields =
          (value as { fields?: Array<{ name: string; value: unknown }> }).fields ?? []
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

async function fetchDepositEvents(start: number, end: number): Promise<FlowEventBlock[]> {
  const url =
    `${FLOW_REST}/v1/events?type=${encodeURIComponent(DEPOSIT_EVENT)}` +
    `&start_height=${start}&end_height=${end}`
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) })
  if (!res.ok) {
    console.log(`[pinnacle-owner-discovery] events ${start}-${end} HTTP ${res.status}`)
    return []
  }
  const json = (await res.json()) as FlowEventBlock[]
  return Array.isArray(json) ? json : []
}

async function getSealedHeight(): Promise<number> {
  const res = await fetch(`${FLOW_REST}/v1/blocks?height=sealed`, {
    signal: AbortSignal.timeout(8000),
  })
  if (!res.ok) throw new Error(`blocks sealed HTTP ${res.status}`)
  const json = (await res.json()) as Array<{ header: { height: string } }>
  return Number(json[0]?.header?.height ?? 0)
}

// Extracts (id, to) from a Pinnacle.Deposit event payload. The on-chain
// shape is an Event wrapper with `id: UInt64` and `to: Address?` fields;
// we tolerate either shape and return null when we can't find both.
function extractDeposit(payloadBase64: string): { nftId: string; to: string } | null {
  try {
    const raw = JSON.parse(atob(payloadBase64))
    const unwrapped = unwrapCdc(raw) as Record<string, unknown>
    const idField = unwrapped?.id
    const toField = unwrapped?.to
    if (idField === undefined || idField === null) return null
    if (toField === undefined || toField === null) return null
    const nftId = String(idField)
    const to = String(toField).toLowerCase()
    if (!nftId || !to.startsWith("0x")) return null
    return { nftId, to }
  } catch (err) {
    console.log(
      `[pinnacle-owner-discovery] decode err: ${err instanceof Error ? err.message : String(err)}`
    )
    return null
  }
}

interface ScanState {
  last_processed_height: number
  total_events_found: number
  total_inserted: number
  total_skipped: number
}

async function loadState(): Promise<ScanState> {
  const { data, error } = await supabase
    .from("flow_backfill_progress")
    .select("last_processed_height, total_events_found, total_inserted, total_skipped")
    .eq("id", SCAN_STATE_ID)
    .maybeSingle()
  if (error) throw new Error(`load state: ${error.message}`)
  return {
    last_processed_height: Number(data?.last_processed_height ?? 0),
    total_events_found: Number(data?.total_events_found ?? 0),
    total_inserted: Number(data?.total_inserted ?? 0),
    total_skipped: Number(data?.total_skipped ?? 0),
  }
}

async function saveState(patch: ScanState): Promise<void> {
  const { error } = await supabase
    .from("flow_backfill_progress")
    .update({
      last_processed_height: patch.last_processed_height,
      total_events_found: patch.total_events_found,
      total_inserted: patch.total_inserted,
      total_skipped: patch.total_skipped,
      updated_at: new Date().toISOString(),
    })
    .eq("id", SCAN_STATE_ID)
  if (error) console.log(`[pinnacle-owner-discovery] save state err: ${error.message}`)
}

Deno.serve(async (req: Request) => {
  const auth = req.headers.get("Authorization") ?? ""
  if (auth !== "Bearer rippackscity2026") {
    return new Response("Unauthorized", { status: 401 })
  }

  const url = new URL(req.url)
  const blocksPerRunParam = Number(
    url.searchParams.get("blocks") ?? DEFAULT_BLOCKS_PER_RUN
  )
  const blocksPerRun = Math.max(
    CHUNK_SIZE,
    Number.isFinite(blocksPerRunParam) ? blocksPerRunParam : DEFAULT_BLOCKS_PER_RUN
  )

  const started = Date.now()
  try {
    const state = await loadState()
    let cursor = state.last_processed_height

    // First-run seed: start at current sealed head and walk backward.
    if (cursor <= 0) {
      cursor = await getSealedHeight()
      console.log(`[pinnacle-owner-discovery] seeding cursor at sealed head ${cursor}`)
    }

    if (cursor <= 0) {
      return new Response(
        JSON.stringify({ ok: true, message: "no history left to scan", cursor }),
        { headers: { "Content-Type": "application/json; charset=utf-8" } }
      )
    }

    const windowEnd = cursor - 1 // previously-scanned block is exclusive
    const windowStart = Math.max(0, windowEnd - blocksPerRun + 1)

    console.log(
      `[pinnacle-owner-discovery] scanning ${windowStart} → ${windowEnd} ` +
        `(${windowEnd - windowStart + 1} blocks, newest-first)`
    )

    let eventsFound = 0
    let inserted = 0
    let skipped = 0
    let lowestScanned = windowEnd + 1 // so that if we bail we don't advance

    // Walk chunks from newest-first so first-seen-wins == most-recent-owner.
    for (let chunkEnd = windowEnd; chunkEnd >= windowStart; chunkEnd -= CHUNK_SIZE) {
      const chunkStart = Math.max(windowStart, chunkEnd - CHUNK_SIZE + 1)
      let blocks: FlowEventBlock[] = []
      try {
        blocks = await fetchDepositEvents(chunkStart, chunkEnd)
      } catch (err) {
        console.log(
          `[pinnacle-owner-discovery] chunk ${chunkStart}-${chunkEnd} err: ` +
            `${err instanceof Error ? err.message : String(err)}`
        )
        // Leave cursor untouched for this chunk so we retry next run.
        break
      }

      // Sort blocks within a chunk by height DESC to preserve newest-first
      // ordering inside the chunk.
      blocks.sort((a, b) => Number(b.block_height) - Number(a.block_height))

      const rows: Array<{
        nft_id: string
        owner: string
        deposit_block_height: number
      }> = []

      for (const blk of blocks) {
        const bh = Number(blk.block_height)
        for (const evt of blk.events ?? []) {
          const parsed = extractDeposit(evt.payload)
          if (!parsed) continue
          eventsFound++
          rows.push({
            nft_id: parsed.nftId,
            owner: parsed.to,
            deposit_block_height: bh,
          })
        }
      }

      // Within this chunk, dedup by nft_id keeping the highest block height
      // (they're already sorted DESC but a tx could have multiple deposits —
      // take the first we see per nft_id).
      const seen = new Set<string>()
      const dedup: typeof rows = []
      for (const r of rows) {
        if (seen.has(r.nft_id)) continue
        seen.add(r.nft_id)
        dedup.push(r)
      }

      if (dedup.length > 0) {
        for (let i = 0; i < dedup.length; i += 200) {
          const batch = dedup.slice(i, i + 200)
          const { error } = await supabase
            .from("pinnacle_ownership_snapshots")
            .upsert(batch, { onConflict: "nft_id", ignoreDuplicates: true })
          if (error) {
            console.log(
              `[pinnacle-owner-discovery] upsert err: ${error.message}`
            )
            skipped += batch.length
          } else {
            inserted += batch.length
          }
        }
      }

      lowestScanned = chunkStart

      if (chunkStart > windowStart) await sleep(INTER_CHUNK_DELAY_MS)
    }

    // Advance cursor to the lowest block we successfully scanned (exclusive
    // for the next run). When we reach 0 we've exhausted history.
    const nextCursor = Math.max(0, lowestScanned)

    await saveState({
      last_processed_height: nextCursor,
      total_events_found: state.total_events_found + eventsFound,
      total_inserted: state.total_inserted + inserted,
      total_skipped: state.total_skipped + skipped,
    })

    return new Response(
      JSON.stringify({
        ok: true,
        windowStart,
        windowEnd,
        blocksScanned: windowEnd - lowestScanned + 1,
        eventsFound,
        inserted,
        skipped,
        cursor: nextCursor,
        elapsed: Date.now() - started,
      }),
      { headers: { "Content-Type": "application/json; charset=utf-8" } }
    )
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.log(`[pinnacle-owner-discovery] fatal: ${msg}`)
    return new Response(
      JSON.stringify({ ok: false, error: msg }),
      { status: 500, headers: { "Content-Type": "application/json; charset=utf-8" } }
    )
  }
})
