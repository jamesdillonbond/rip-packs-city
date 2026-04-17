#!/usr/bin/env node
// scripts/resolve-pinnacle-sales.ts
//
// Resolves pinnacle_sales rows where edition_id IS NULL by borrowing each
// NFT from the Pinnacle contract's own collection (0xedf9df96c92f4595 acts
// as custodian for Dapper-held Pinnacle NFTs) via the contract-exposed
// public path `Pinnacle.CollectionPublicPath`, then reading the NFT's
// editionID field.
//
// On Pinnacle, NFT IDs are UInt64 but edition IDs are Int. We match each
// on-chain editionID against pinnacle_editions.id (text) and update
// pinnacle_sales.edition_id directly. The pinnacle_nft_map cache table is
// also upserted so repeat runs short-circuit the Cadence call.
//
// Usage:  npx tsx scripts/resolve-pinnacle-sales.ts [--limit=100] [--dry-run]
// Env:    SUPABASE_URL (optional), SUPABASE_SERVICE_ROLE_KEY (required)

import { createClient } from "@supabase/supabase-js"

const SUPABASE_URL =
  process.env.SUPABASE_URL || "https://bxcqstmqfzmuolpuynti.supabase.co"
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ""
const FLOW_REST = "https://rest-mainnet.onflow.org"

const DRY_RUN = process.argv.includes("--dry-run")
const LIMIT = (() => {
  const hit = process.argv.find((a) => a.startsWith("--limit="))
  const n = hit ? Number(hit.slice("--limit=".length)) : 100
  return Number.isFinite(n) && n > 0 ? n : 100
})()
const BATCH_SIZE = 25
const DELAY_MS = 150

if (!SERVICE_KEY) {
  console.error("SUPABASE_SERVICE_ROLE_KEY not set")
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY)

// Batches NFT borrows through the contract's own public collection.
// First tries Pinnacle.CollectionPublicPath (contract-exposed constant);
// falls back to the legacy /public/PinnacleCollection literal.
const BORROW_SCRIPT = `
import Pinnacle from 0xedf9df96c92f4595
import NonFungibleToken from 0x1d7e57aa55817448

access(all) fun main(ids: [UInt64]): {UInt64: Int} {
  let out: {UInt64: Int} = {}
  let acct = getAccount(0xedf9df96c92f4595)
  let ref = acct.capabilities.borrow<&{NonFungibleToken.CollectionPublic}>(Pinnacle.CollectionPublicPath)
    ?? acct.capabilities.borrow<&{NonFungibleToken.CollectionPublic}>(/public/PinnacleCollection)
    ?? panic("cannot borrow Pinnacle collection")

  for id in ids {
    let nftOpt = ref.borrowNFT(id)
    if nftOpt == nil { continue }
    let casted = nftOpt! as! &Pinnacle.NFT
    out[id] = casted.editionID
  }
  return out
}
`.trim()

interface SaleRow {
  id: string
  nft_id: string
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function loadTargets(): Promise<SaleRow[]> {
  const { data, error } = await supabase
    .from("pinnacle_sales")
    .select("id, nft_id")
    .is("edition_id", null)
    .not("nft_id", "is", null)
    .limit(LIMIT)
  if (error) throw new Error(`load sales: ${error.message}`)
  const seen = new Set<string>()
  const out: SaleRow[] = []
  for (const r of (data ?? []) as SaleRow[]) {
    if (!r.nft_id) continue
    if (seen.has(r.nft_id)) continue
    seen.add(r.nft_id)
    out.push(r)
  }
  return out
}

interface CdcValue {
  type?: string
  value?: unknown
}

interface CdcKeyValue {
  key: CdcValue
  value: CdcValue
}

async function runBorrow(ids: string[]): Promise<Map<string, string>> {
  const body = {
    script: Buffer.from(BORROW_SCRIPT, "utf8").toString("base64"),
    arguments: [
      Buffer.from(
        JSON.stringify({
          type: "Array",
          value: ids.map((v) => ({ type: "UInt64", value: String(v) })),
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
    throw new Error(`script HTTP ${res.status}: ${text.slice(0, 300)}`)
  }

  const raw = (await res.text()).trim().replace(/^"|"$/g, "")
  const decoded = JSON.parse(
    Buffer.from(raw, "base64").toString("utf8")
  ) as CdcValue

  const out = new Map<string, string>()
  const entries = (decoded?.value as CdcKeyValue[] | undefined) ?? []
  for (const entry of entries) {
    const nftId = String(entry.key?.value ?? "")
    const editionId = String(entry.value?.value ?? "")
    if (!nftId || !editionId) continue
    out.set(nftId, editionId)
  }
  return out
}

async function verifyEditionIds(
  editionIds: string[]
): Promise<Set<string>> {
  if (editionIds.length === 0) return new Set()
  const { data, error } = await supabase
    .from("pinnacle_editions")
    .select("id")
    .in("id", editionIds)
  if (error) {
    console.log(`[resolve-pinnacle] verify err: ${error.message}`)
    return new Set()
  }
  return new Set((data ?? []).map((r) => String((r as { id: string }).id)))
}

async function upsertMap(
  rows: Array<{ nft_id: string; edition_key: string }>
): Promise<void> {
  if (DRY_RUN || rows.length === 0) return
  const { error } = await supabase
    .from("pinnacle_nft_map")
    .upsert(rows, { onConflict: "nft_id", ignoreDuplicates: true })
  if (error) console.log(`[resolve-pinnacle] map upsert err: ${error.message}`)
}

async function updateSales(nftId: string, editionId: string): Promise<number> {
  if (DRY_RUN) return 0
  const { error, count } = await supabase
    .from("pinnacle_sales")
    .update({ edition_id: editionId }, { count: "exact" })
    .eq("nft_id", nftId)
    .is("edition_id", null)
  if (error) {
    console.log(
      `[resolve-pinnacle] sales update nft=${nftId}: ${error.message}`
    )
    return 0
  }
  return count ?? 0
}

async function main() {
  console.log(
    `[resolve-pinnacle] starting limit=${LIMIT}${DRY_RUN ? " (dry run)" : ""}`
  )

  const targets = await loadTargets()
  console.log(`[resolve-pinnacle] ${targets.length} distinct unresolved nft_ids`)
  if (targets.length === 0) {
    console.log("nothing to do.")
    return
  }

  let queried = 0
  let resolved = 0
  let missingEdition = 0
  let salesUpdated = 0
  let failed = 0

  for (let i = 0; i < targets.length; i += BATCH_SIZE) {
    const batch = targets.slice(i, i + BATCH_SIZE)
    const batchIds = batch.map((r) => r.nft_id)
    queried += batch.length

    let matches: Map<string, string>
    try {
      matches = await runBorrow(batchIds)
    } catch (e) {
      console.log(
        `[resolve-pinnacle] batch ${i}-${i + batch.length} err: ${(e as Error).message}`
      )
      failed += batch.length
      await sleep(500)
      continue
    }

    const editionIds = Array.from(new Set(Array.from(matches.values())))
    const existingEditions = await verifyEditionIds(editionIds)

    const mapRows: Array<{ nft_id: string; edition_key: string }> = []
    for (const id of batchIds) {
      const editionId = matches.get(id)
      if (!editionId) {
        failed++
        continue
      }
      resolved++
      mapRows.push({ nft_id: id, edition_key: editionId })

      if (!existingEditions.has(editionId)) {
        missingEdition++
        if (DRY_RUN) {
          console.log(
            `  · ${id} → edition ${editionId} (not in pinnacle_editions yet)`
          )
        }
        continue
      }

      if (DRY_RUN) {
        console.log(`  · ${id} → edition ${editionId}`)
        continue
      }

      salesUpdated += await updateSales(id, editionId)
    }

    await upsertMap(mapRows)

    console.log(
      `[resolve-pinnacle] batch ${i}-${i + batch.length}: resolved=${mapRows.length} totals queried=${queried} resolved=${resolved} failed=${failed} missingEdition=${missingEdition} salesUpdated=${salesUpdated}`
    )
    await sleep(DELAY_MS)
  }

  console.log("")
  console.log("═══ resolve-pinnacle summary ═══")
  console.log(`  queried:        ${queried}`)
  console.log(`  resolved:       ${resolved}`)
  console.log(`  failed:         ${failed}`)
  console.log(`  missingEdition: ${missingEdition}`)
  console.log(`  salesUpdated:   ${salesUpdated}`)
  console.log("═════════════════════════════════")
}

main().catch((err) => {
  console.error("fatal:", err)
  process.exit(1)
})
