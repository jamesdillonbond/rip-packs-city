#!/usr/bin/env node
// Backfill seller_address + buyer_address on every nfl_all_day row in
// sales_2026 where seller_address IS NULL. Pure UPDATE — no INSERT path.
//
// Source of truth: A.3cdbb3d569211ff3.NFTStorefrontV2.ListingCompleted event
// in the sale's own transaction. Carries payload.storefrontAddress (real
// seller) and payload.buyer (real buyer) directly. The current rows have
// buyer_address set to 0x3cdbb3d569211ff3 (Flowty fee router; not the buyer)
// because the indexer used to misuse commissionReceiver for buyer; (a) fixed
// the indexer forward, this script fixes the historical rows.
//
// Block heights for these rows are all post-mainnet26 cap (>= 137,390,146)
// so we hit https://rest-mainnet.onflow.org directly — spork-proxy doesn't
// apply.
//
// Usage:
//   node scripts/backfill-allday-seller-buyer.mjs --dry-run    (first 20, no writes)
//   node scripts/backfill-allday-seller-buyer.mjs              (full run, resumable)

import { readFileSync, writeFileSync, existsSync } from 'fs'
import { resolve } from 'path'
import { createClient } from '@supabase/supabase-js'

function loadEnv() {
  const envPath = resolve(process.cwd(), '.env.local')
  const lines = readFileSync(envPath, 'utf-8').split('\n')
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    let val = trimmed.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
      val = val.slice(1, -1)
    if (!process.env[key]) process.env[key] = val
  }
}
loadEnv()

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const DRY_RUN = process.argv.includes('--dry-run')
const ALLDAY_COLLECTION_ID = 'dee28451-5d62-409e-a1ad-a83f763ac070'
const FLOW_REST = 'https://rest-mainnet.onflow.org'
const STOREFRONT_EVENT = 'A.3cdbb3d569211ff3.NFTStorefrontV2.ListingCompleted'
const STOREFRONT_ADDRESS = '0x3cdbb3d569211ff3'
const RATE_LIMIT_RPS = 10
const REQUEST_TIMEOUT_MS = 8000
const CHECKPOINT_PATH = resolve(process.cwd(), 'scripts', '.backfill-allday-seller-buyer.checkpoint.json')
const DRY_RUN_SAMPLE = 20

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function unwrapCdc(node) {
  if (node === null || node === undefined) return node
  if (Array.isArray(node)) return node.map(unwrapCdc)
  if (typeof node !== 'object') return node
  const { type, value } = node
  if (type !== undefined && value !== undefined) {
    switch (type) {
      case 'Optional': return value === null ? null : unwrapCdc(value)
      case 'Bool': case 'String': case 'Address': case 'Path':
      case 'Int': case 'UInt': case 'Int64': case 'UInt64': case 'UFix64': case 'Fix64':
      case 'UInt32': case 'Int32': case 'UInt16': case 'Int16': case 'UInt8': case 'Int8':
        return value
      case 'Array': return value.map(unwrapCdc)
      case 'Dictionary': {
        const out = {}
        for (const kv of value) out[String(unwrapCdc(kv.key))] = unwrapCdc(kv.value)
        return out
      }
      case 'Struct': case 'Resource': case 'Event': case 'Contract': case 'Enum': {
        const out = {}
        for (const f of (value.fields ?? [])) out[f.name] = unwrapCdc(f.value)
        return out
      }
      case 'Type': return { staticType: value.staticType }
      default: return value
    }
  }
  return node
}

function normalize(raw) {
  if (typeof raw !== 'string') return null
  const hex = raw.trim().toLowerCase().replace(/^0x/, '')
  if (!/^[0-9a-f]{1,16}$/.test(hex)) return null
  return `0x${hex.padStart(16, '0')}`
}

function loadCheckpoint() {
  if (!existsSync(CHECKPOINT_PATH)) return { processed_ids: [] }
  try { return JSON.parse(readFileSync(CHECKPOINT_PATH, 'utf-8')) }
  catch { return { processed_ids: [] } }
}

function saveCheckpoint(processedIds) {
  writeFileSync(CHECKPOINT_PATH, JSON.stringify({ processed_ids: processedIds, updated_at: new Date().toISOString() }))
}

async function fetchTxResults(txHash) {
  const clean = String(txHash).replace(/^0x/, '')
  const res = await fetch(`${FLOW_REST}/v1/transaction_results/${clean}`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (res.status === 404) return { notFound: true }
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return { json: await res.json() }
}

function findListing(events, nftId) {
  for (const e of events ?? []) {
    if (e.type !== STOREFRONT_EVENT) continue
    let p
    try { p = unwrapCdc(JSON.parse(Buffer.from(e.payload, 'base64').toString('utf8'))) }
    catch { continue }
    if (p?.purchased !== true) continue
    if (String(p.nftID) !== String(nftId)) continue
    return p
  }
  return null
}

async function loadTargets() {
  // The `sales` table is partitioned by year (sales_2020 ... sales_2026).
  // PostgREST exposes the parent (`sales`); writes route to the right
  // partition automatically. All current NULL-seller AllDay rows live in
  // sales_2026 (verified via SQL), but we don't filter by year — the
  // collection='nfl_all_day' + seller_address IS NULL filter is enough.
  // Page in 1000-row chunks because PostgREST has a default row cap.
  const all = []
  let offset = 0
  const PAGE = 1000
  while (true) {
    const { data, error } = await supabase
      .from('sales')
      .select('id, sold_at, nft_id, transaction_hash, seller_address, buyer_address')
      .eq('collection', 'nfl_all_day')
      .is('seller_address', null)
      .order('sold_at', { ascending: false })
      .range(offset, offset + PAGE - 1)
    if (error) throw new Error(`load: ${error.message}`)
    if (!data || data.length === 0) break
    for (const r of data) all.push(r)
    if (data.length < PAGE) break
    offset += PAGE
  }
  return all
}

async function main() {
  const startedAt = Date.now()
  const ckpt = DRY_RUN ? { processed_ids: [] } : loadCheckpoint()
  const processed = new Set(ckpt.processed_ids ?? [])

  const allRows = await loadTargets()
  console.log(`[backfill-allday-seller-buyer] DRY_RUN=${DRY_RUN}`)
  console.log(`[backfill-allday-seller-buyer] target rows (NULL seller): ${allRows.length}`)

  const rows = DRY_RUN ? allRows.slice(0, DRY_RUN_SAMPLE) : allRows.filter((r) => !processed.has(r.id))
  console.log(`[backfill-allday-seller-buyer] processing this run: ${rows.length}`)
  if (rows.length === 0) {
    console.log('Nothing to do.')
    return
  }

  let resolved = 0
  let failedTxNotFound = 0
  let failedNoListing = 0
  let failedOther = 0
  let storefrontTaintedSkipped = 0

  const intervalMs = Math.ceil(1000 / RATE_LIMIT_RPS)
  const samples = []

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    const tickStart = Date.now()
    let outcome = 'ok'
    let seller = null
    let buyer = null

    try {
      const txOut = await fetchTxResults(r.transaction_hash)
      if (txOut.notFound) {
        failedTxNotFound++
        outcome = 'tx_not_found'
      } else {
        const listing = findListing(txOut.json.events, r.nft_id)
        if (!listing) {
          failedNoListing++
          outcome = 'no_listing'
        } else {
          seller = normalize(listing.storefrontAddress)
          buyer = normalize(listing.buyer)
          if (!seller || !buyer) {
            failedOther++
            outcome = 'unparseable_addresses'
          } else if (seller === STOREFRONT_ADDRESS || buyer === STOREFRONT_ADDRESS) {
            // Defensive — should never happen for a Flowty fork sale, but if
            // either party is the storefront contract itself, skip rather
            // than corrupt the row. Probably indicates a bulk-listing edge
            // case where the matched event is the wrong one.
            storefrontTaintedSkipped++
            outcome = 'storefront_tainted'
          } else {
            if (DRY_RUN) {
              samples.push({
                id: r.id,
                nft_id: r.nft_id,
                tx: String(r.transaction_hash).slice(0, 12) + '…',
                seller,
                buyer,
                old_buyer: r.buyer_address,
              })
            } else {
              const { error: updErr } = await supabase
                .from('sales')
                .update({ seller_address: seller, buyer_address: buyer })
                .eq('id', r.id)
                .eq('sold_at', r.sold_at)
              if (updErr) {
                failedOther++
                outcome = `update_error:${updErr.message}`
              } else {
                resolved++
                processed.add(r.id)
              }
            }
          }
        }
      }
    } catch (e) {
      failedOther++
      outcome = `fetch_error:${e.message}`
    }

    if (!DRY_RUN && (i + 1) % 50 === 0) {
      saveCheckpoint([...processed])
      console.log(
        `[backfill-allday-seller-buyer] progress ${i + 1}/${rows.length}  ` +
          `resolved=${resolved} tx_404=${failedTxNotFound} no_listing=${failedNoListing} other=${failedOther} tainted=${storefrontTaintedSkipped}`
      )
    } else if (DRY_RUN) {
      console.log(`  [${i + 1}/${rows.length}] nft=${r.nft_id} → ${outcome}`)
    }

    const elapsed = Date.now() - tickStart
    if (elapsed < intervalMs) await sleep(intervalMs - elapsed)
  }

  if (!DRY_RUN) saveCheckpoint([...processed])

  console.log('\n=== Summary ===')
  console.log(`Mode                 : ${DRY_RUN ? 'DRY RUN (no writes)' : 'LIVE'}`)
  console.log(`Rows processed       : ${rows.length}`)
  console.log(`Resolved             : ${DRY_RUN ? samples.length + ' parsed' : resolved}`)
  console.log(`tx_not_found         : ${failedTxNotFound}`)
  console.log(`no_listing_event     : ${failedNoListing}`)
  console.log(`storefront_tainted   : ${storefrontTaintedSkipped}`)
  console.log(`other_failures       : ${failedOther}`)
  console.log(`Elapsed              : ${((Date.now() - startedAt) / 1000).toFixed(1)}s`)

  if (DRY_RUN && samples.length > 0) {
    console.log('\n=== DRY-RUN SAMPLES ===')
    for (const s of samples) {
      console.log(
        `  nft=${s.nft_id.padStart(8)}  ` +
          `seller=${s.seller}  buyer=${s.buyer}  ` +
          `(old_buyer=${s.old_buyer})`
      )
    }
    console.log('\nVerify:')
    console.log('  - Both seller and buyer should look like real Flow addresses (0x + 16 hex chars)')
    console.log(`  - Neither should equal ${STOREFRONT_ADDRESS} (the Flowty storefront)`)
    console.log('  - old_buyer should be the storefront address (the bug we are fixing)')
    console.log('\nIf the sample looks correct, re-run without --dry-run.')
  }
}

main().catch((e) => {
  console.error('Fatal:', e)
  process.exit(1)
})
