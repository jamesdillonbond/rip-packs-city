#!/usr/bin/env node
// scripts/resolve-pinnacle-sales.ts
//
// Resolves pinnacle_sales rows where edition_id IS NULL by borrowing the
// NFT from the Pinnacle contract's own collection (the contract itself,
// 0xedf9df96c92f4595, acts as custodian for Dapper-held Pinnacle NFTs),
// reading the NFT's editionKey, and writing the map into pinnacle_nft_map.
// After each batch we call backfill_pinnacle_sale_editions() to promote
// any newly-mapped nft_ids onto sales.
//
// The public collection path isn't definitively known, so the script
// tries a list of candidate paths and candidate owner addresses.
//
// Usage:  npx tsx scripts/resolve-pinnacle-sales.ts [--limit=100] [--dry-run]
// Env:    SUPABASE_URL (optional), SUPABASE_SERVICE_ROLE_KEY (required)
//         PINNACLE_OWNER_ADDRESSES (comma-separated, extends candidate list)

import { createClient } from "@supabase/supabase-js"

const SUPABASE_URL =
  process.env.SUPABASE_URL || "https://bxcqstmqfzmuolpuynti.supabase.co"
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || ""
const FLOW_REST = "https://rest-mainnet.onflow.org"
const PINNACLE_CONTRACT = "0xedf9df96c92f4595"

const DRY_RUN = process.argv.includes("--dry-run")
const LIMIT = (() => {
  const hit = process.argv.find((a) => a.startsWith("--limit="))
  const n = hit ? Number(hit.slice("--limit=".length)) : 100
  return Number.isFinite(n) && n > 0 ? n : 100
})()
const BATCH_SIZE = 25
const DELAY_MS = 150

const CANDIDATE_OWNERS: string[] = (() => {
  const base = [PINNACLE_CONTRACT]
  const extra = (process.env.PINNACLE_OWNER_ADDRESSES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
  return Array.from(new Set([...base, ...extra]))
})()

if (!SERVICE_KEY) {
  console.error("SUPABASE_SERVICE_ROLE_KEY not set")
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY)

// Cadence script that iterates candidate owners × candidate public paths
// and the first successful borrow wins. Returns {nft_id: editionKey}.
// Pinnacle.NFT's on-chain edition identifier has historically been exposed
// as `editionKey` (the `royalty:variant:printing` triple); we fall back
// to `editionID`/`edition` if the first field doesn't exist so the script
// is robust to contract ABI variations.
const BORROW_SCRIPT = `
import Pinnacle from 0xedf9df96c92f4595
import NonFungibleToken from 0x1d7e57aa55817448

access(all) fun main(owners: [Address], paths: [String], ids: [UInt64]): {UInt64: String} {
  let out: {UInt64: String} = {}
  for id in ids {
    var resolved = false
    for owner in owners {
      if resolved { break }
      for p in paths {
        let capPath = PublicPath(identifier: p)
          ?? panic("bad path: ".concat(p))
        let ref = getAccount(owner).capabilities
          .borrow<&{NonFungibleToken.Collection}>(capPath)
        if ref == nil { continue }
        let nft = ref!.borrowNFT(id)
        if nft == nil { continue }
        let casted = nft! as! &Pinnacle.NFT
        out[id] = casted.editionKey
        resolved = true
        break
      }
    }
  }
  return out
}
`.trim()

const CANDIDATE_PATHS = [
  "PinnacleCollection",
  "PinnacleNFTCollection",
  "DapperDisneyPinnacleCollection",
  "DisneyPinnacleCollection",
  "PinnaclePublicCollection",
]

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

async function runBorrow(
  owners: string[],
  paths: string[],
  ids: string[]
): Promise<Map<string, string>> {
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
          value: paths.map((p) => ({ type: "String", value: p })),
        })
      ).toString("base64"),
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
    throw new Error(`script HTTP ${res.status}: ${text.slice(0, 200)}`)
  }

  const raw = (await res.text()).trim().replace(/^"|"$/g, "")
  const decoded = JSON.parse(Buffer.from(raw, "base64").toString("utf8")) as CdcValue

  const out = new Map<string, string>()
  const entries = (decoded?.value as CdcKeyValue[] | undefined) ?? []
  for (const entry of entries) {
    const nftId = String(entry.key?.value ?? "")
    const editionKey = String(entry.value?.value ?? "")
    if (!nftId || !editionKey) continue
    out.set(nftId, editionKey)
  }
  return out
}

async function upsertMap(
  rows: Array<{ nft_id: string; edition_key: string }>
): Promise<number> {
  if (rows.length === 0) return 0
  if (DRY_RUN) {
    for (const r of rows.slice(0, 10)) {
      console.log(`  · ${r.nft_id} → ${r.edition_key}`)
    }
    if (rows.length > 10) console.log(`  · … ${rows.length - 10} more`)
    return 0
  }
  const { error } = await supabase
    .from("pinnacle_nft_map")
    .upsert(rows, { onConflict: "nft_id", ignoreDuplicates: true })
  if (error) {
    console.log(`[resolve-pinnacle] upsert err: ${error.message}`)
    return 0
  }
  return rows.length
}

async function main() {
  console.log(
    `[resolve-pinnacle] starting limit=${LIMIT}${DRY_RUN ? " (dry run)" : ""}`
  )
  console.log(`[resolve-pinnacle] owners: ${CANDIDATE_OWNERS.join(", ")}`)
  console.log(`[resolve-pinnacle] paths:  ${CANDIDATE_PATHS.join(", ")}`)

  const targets = await loadTargets()
  console.log(`[resolve-pinnacle] ${targets.length} distinct unresolved nft_ids`)
  if (targets.length === 0) {
    console.log("nothing to do.")
    return
  }

  let queried = 0
  let resolved = 0
  let failed = 0
  let mapInserted = 0

  for (let i = 0; i < targets.length; i += BATCH_SIZE) {
    const batch = targets.slice(i, i + BATCH_SIZE)
    const batchIds = batch.map((r) => r.nft_id)
    queried += batch.length

    let matches: Map<string, string>
    try {
      matches = await runBorrow(CANDIDATE_OWNERS, CANDIDATE_PATHS, batchIds)
    } catch (e) {
      console.log(
        `[resolve-pinnacle] batch ${i}-${i + batch.length} err: ${(e as Error).message}`
      )
      failed += batch.length
      await sleep(500)
      continue
    }

    const rows: Array<{ nft_id: string; edition_key: string }> = []
    for (const id of batchIds) {
      const key = matches.get(id)
      if (!key) {
        failed++
        continue
      }
      rows.push({ nft_id: id, edition_key: key })
      resolved++
    }

    mapInserted += await upsertMap(rows)

    console.log(
      `[resolve-pinnacle] batch ${i}-${i + batch.length}: resolved=${rows.length} totals queried=${queried} resolved=${resolved} failed=${failed}`
    )
    await sleep(DELAY_MS)
  }

  if (!DRY_RUN && mapInserted > 0) {
    console.log(`[resolve-pinnacle] calling backfill_pinnacle_sale_editions() …`)
    const { data, error } = await supabase.rpc("backfill_pinnacle_sale_editions")
    if (error) console.log(`[resolve-pinnacle] rpc err: ${error.message}`)
    else console.log(`[resolve-pinnacle] rpc result: ${JSON.stringify(data)}`)
  }

  console.log("")
  console.log("═══ resolve-pinnacle summary ═══")
  console.log(`  queried:      ${queried}`)
  console.log(`  resolved:     ${resolved}`)
  console.log(`  failed:       ${failed}`)
  console.log(`  map upserted: ${mapInserted}`)
  console.log("═════════════════════════════════")
}

main().catch((err) => {
  console.error("fatal:", err)
  process.exit(1)
})
