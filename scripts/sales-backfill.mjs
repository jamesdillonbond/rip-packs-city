#!/usr/bin/env node

/**
 * Historical on-chain sales backfill via Flow NFTStorefrontV2 ListingCompleted events.
 *
 * Usage:
 *   node scripts/sales-backfill.mjs [--start-block N] [--end-block N]
 *
 * Defaults: end = current sealed block, start = end - 86400 (~1 day)
 * For 30-day backfill: --start-block $(current - 2592000)
 */

import "dotenv/config"
import * as fcl from "@onflow/fcl"
import { createClient } from "@supabase/supabase-js"
import crypto from "crypto"

// ── Config ────────────────────────────────────────────────────────────────────

fcl.config()
  .put("accessNode.api", "https://rest-mainnet.onflow.org")
  .put("flow.network", "mainnet")

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
)

const TOPSHOT_COLLECTION_ID = "95f28a17-224a-4025-96ad-adf8a4c63bfd"
const DAPPER_MERCHANT = "0xc1e4f4f4c4257510"
const EVENT_TYPE = "A.4eb8a10cb9f87357.NFTStorefrontV2.ListingCompleted"
const CHUNK_SIZE = 250
const MAX_RETRIES = 3

// ── CLI Args ──────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2)
  let startBlock = null
  let endBlock = null
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--start-block" && args[i + 1]) startBlock = parseInt(args[i + 1], 10)
    if (args[i] === "--end-block" && args[i + 1]) endBlock = parseInt(args[i + 1], 10)
  }
  return { startBlock, endBlock }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function delay(ms) { return new Promise(r => setTimeout(r, ms)) }

function isTopShot(nftType) { return typeof nftType === "string" && nftType.includes("TopShot") }

function marketplace(commissionReceiver) {
  if (!commissionReceiver || commissionReceiver === DAPPER_MERCHANT) return "topshot"
  return "other"
}

function toIso(ts) {
  if (typeof ts === "string") {
    const d = new Date(ts)
    if (!isNaN(d.getTime())) return d.toISOString()
  }
  if (typeof ts === "number") {
    const d = new Date(ts > 1e12 ? ts : ts * 1000)
    if (!isNaN(d.getTime())) return d.toISOString()
  }
  return new Date().toISOString()
}

async function fetchEventsWithRetry(startH, endH) {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const events = await fcl.send([
        fcl.getEventsAtBlockHeightRange(EVENT_TYPE, startH, endH),
      ]).then(fcl.decode)
      return events ?? []
    } catch (err) {
      console.log(`  ⚠ Chunk ${startH}-${endH} attempt ${attempt + 1} failed: ${err.message}`)
      if (attempt < MAX_RETRIES - 1) await delay(2000)
    }
  }
  return []
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const start = Date.now()
  const { startBlock: argStart, endBlock: argEnd } = parseArgs()

  // Get current sealed block
  const latestBlock = await fcl.send([fcl.getBlock(true)]).then(fcl.decode)
  const currentHeight = Number(latestBlock.height)
  console.log(`Current sealed block: ${currentHeight}`)

  const endBlock = argEnd ?? currentHeight
  const startBlock = argStart ?? endBlock - 86400

  console.log(`Scanning blocks ${startBlock} → ${endBlock} (${endBlock - startBlock} blocks)`)

  // Scan events
  const allEvents = []
  let chunksScanned = 0

  for (let h = startBlock; h <= endBlock; h += CHUNK_SIZE) {
    const end = Math.min(h + CHUNK_SIZE - 1, endBlock)
    const events = await fetchEventsWithRetry(h, end)

    for (const evt of events) {
      const d = evt.data ?? evt
      if (d.purchased === true && isTopShot(d.nftType ?? "")) {
        allEvents.push({
          blockHeight: evt.blockHeight ?? h,
          blockTimestamp: evt.blockTimestamp ?? new Date().toISOString(),
          transactionId: evt.transactionId ?? null,
          data: d,
        })
      }
    }

    chunksScanned++
    if (chunksScanned % 4 === 0) {
      const blocksProcessed = end - startBlock + 1
      if (blocksProcessed % 1000 < CHUNK_SIZE) {
        console.log(`  ${blocksProcessed}/${endBlock - startBlock} blocks | ${allEvents.length} events`)
      }
    }

    await delay(100)
  }

  console.log(`\nScan complete: ${allEvents.length} TopShot sale events found`)

  if (allEvents.length === 0) {
    console.log("No events to process. Done.")
    return
  }

  // Resolve nftIDs
  const nftIds = [...new Set(allEvents.map(e => String(e.data.nftID)))]
  console.log(`Resolving ${nftIds.length} unique nftIDs...`)

  // Check wallet_moments_cache
  const cacheMap = new Map()
  for (let i = 0; i < nftIds.length; i += 500) {
    const batch = nftIds.slice(i, i + 500)
    const { data: rows } = await supabase
      .from("wallet_moments_cache")
      .select("moment_id, edition_key, serial_number")
      .in("moment_id", batch)
    if (rows) {
      for (const r of rows) {
        if (r.edition_key) cacheMap.set(r.moment_id, { edition_key: r.edition_key, serial: r.serial_number ?? 0 })
      }
    }
  }
  console.log(`  wallet_moments_cache: ${cacheMap.size} hits`)

  // Check moments table for remaining
  const remaining = nftIds.filter(id => !cacheMap.has(id))
  const momentsMap = new Map()
  if (remaining.length > 0) {
    for (let i = 0; i < remaining.length; i += 500) {
      const batch = remaining.slice(i, i + 500)
      const { data: rows } = await supabase
        .from("moments")
        .select("nft_id, edition_id")
        .in("nft_id", batch)
      if (rows) {
        for (const r of rows) {
          if (r.edition_id) momentsMap.set(r.nft_id, r.edition_id)
        }
      }
    }
  }
  console.log(`  moments table: ${momentsMap.size} hits`)

  // Resolve edition keys to UUIDs
  const editionKeys = [...new Set([...cacheMap.values()].map(v => v.edition_key))]
  const edKeyToId = new Map()
  if (editionKeys.length > 0) {
    for (let i = 0; i < editionKeys.length; i += 500) {
      const batch = editionKeys.slice(i, i + 500)
      const { data: rows } = await supabase
        .from("editions")
        .select("id, external_id")
        .in("external_id", batch)
        .eq("collection_id", TOPSHOT_COLLECTION_ID)
      if (rows) {
        for (const r of rows) edKeyToId.set(r.external_id, r.id)
      }
    }
  }
  console.log(`  edition keys resolved: ${edKeyToId.size}`)

  // Build sales
  const sales = []
  const unresolved = []

  for (const evt of allEvents) {
    const nftId = String(evt.data.nftID)
    let editionId = null
    let serial = 0

    const cached = cacheMap.get(nftId)
    if (cached) {
      editionId = edKeyToId.get(cached.edition_key) ?? null
      serial = cached.serial ?? 0
    } else {
      editionId = momentsMap.get(nftId) ?? null
    }

    if (!editionId) {
      unresolved.push(nftId)
      continue
    }

    sales.push({
      id: crypto.randomUUID(),
      edition_id: editionId,
      collection_id: TOPSHOT_COLLECTION_ID,
      collection: "nba_top_shot",
      nft_id: nftId,
      price_usd: parseFloat(evt.data.salePrice) || 0,
      serial_number: serial,
      sold_at: toIso(evt.blockTimestamp),
      marketplace: marketplace(evt.data.commissionReceiver),
      source: "onchain",
      block_height: evt.blockHeight,
      transaction_hash: evt.transactionId ?? null,
      buyer_address: null,
      seller_address: null,
      ingested_at: new Date().toISOString(),
    })
  }

  console.log(`\nResolved: ${sales.length}, Unresolved: ${unresolved.length}`)

  // Insert in batches
  let inserted = 0
  let duped = 0

  for (let i = 0; i < sales.length; i += 100) {
    const batch = sales.slice(i, i + 100)
    try {
      const { error } = await supabase.from("sales").insert(batch)
      if (error) {
        if (error.code === "23505") {
          duped += batch.length
        } else {
          // Try individual inserts
          for (const sale of batch) {
            const { error: e } = await supabase.from("sales").insert(sale)
            if (e) duped++; else inserted++
          }
          continue
        }
      } else {
        inserted += batch.length
      }
    } catch {
      duped += batch.length
    }

    if ((i / 100) % 10 === 0 && i > 0) {
      console.log(`  Inserted ${inserted}/${sales.length}, dupes: ${duped}`)
    }
  }

  // Update cursor if we extended it
  const { data: cursor } = await supabase
    .from("event_cursor")
    .select("last_processed_block")
    .eq("id", "topshot_sales")
    .single()

  const cursorBlock = Number(cursor?.last_processed_block ?? 0)
  if (endBlock > cursorBlock) {
    await supabase
      .from("event_cursor")
      .update({ last_processed_block: endBlock, updated_at: new Date().toISOString() })
      .eq("id", "topshot_sales")
    console.log(`\nCursor updated: ${cursorBlock} → ${endBlock}`)
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(1)
  console.log(`
════════════════════════════════════════
  BACKFILL COMPLETE
  Blocks scanned:  ${endBlock - startBlock}
  Events found:    ${allEvents.length}
  Sales resolved:  ${sales.length}
  Inserted:        ${inserted}
  Duplicates:      ${duped}
  Unresolved:      ${unresolved.length}
  Elapsed:         ${elapsed}s
════════════════════════════════════════`)
}

main().catch(err => {
  console.error("Fatal error:", err)
  process.exit(1)
})
