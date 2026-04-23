#!/usr/bin/env node

import { readFileSync } from 'fs'
import { resolve } from 'path'
import { createClient } from '@supabase/supabase-js'

/* ── env ─────────────────────────────────────────────────────────── */

function loadEnv() {
  try {
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
  } catch {
    console.error('[scan-historical-storefront] Could not read .env.local — run from project root')
    process.exit(1)
  }
}
loadEnv()

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const DRY_RUN = process.argv.includes('--dry-run')

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

/* ── constants ──────────────────────────────────────────────────── */

const CHUNK_SIZE = 249
const DELAY_MS = 60
const EVENT_TYPE = 'A.4eb8a10cb9f87357.NFTStorefrontV2.ListingAvailable'
const CHECKPOINT_KEY = 'storefront_audit'
const START_BLOCK = 85_000_000
const FINAL_BLOCK = 137_390_145
const FLUSH_EVERY_N_CHUNKS = 500
const REQUEST_TIMEOUT_MS = 20_000

const SPORKS = [
  { id: 25, maxBlock: 106_258_784, url: 'http://access-001.mainnet25.nodes.onflow.org:8070' },
  { id: 26, maxBlock: 137_390_145, url: 'http://access-001.mainnet26.nodes.onflow.org:8070' },
]

function nodeForBlock(block) {
  for (const s of SPORKS) {
    if (block <= s.maxBlock) return s
  }
  return null
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ── Cadence payload unwrap (same shape as sales-indexer routes) ── */

function unwrapCdc(node) {
  if (node === null || node === undefined) return node
  if (Array.isArray(node)) return node.map(unwrapCdc)
  if (typeof node !== 'object') return node
  const { type, value } = node
  if (type !== undefined && value !== undefined) {
    switch (type) {
      case 'Optional':
        return value === null ? null : unwrapCdc(value)
      case 'Bool':
      case 'String':
      case 'Address':
      case 'Path':
      case 'Character':
      case 'Int':
      case 'UInt':
      case 'Int8':
      case 'Int16':
      case 'Int32':
      case 'Int64':
      case 'Int128':
      case 'Int256':
      case 'UInt8':
      case 'UInt16':
      case 'UInt32':
      case 'UInt64':
      case 'UInt128':
      case 'UInt256':
      case 'Word8':
      case 'Word16':
      case 'Word32':
      case 'Word64':
      case 'Fix64':
      case 'UFix64':
        return value
      case 'Array':
        return value.map(unwrapCdc)
      case 'Dictionary': {
        const out = {}
        for (const kv of value) out[String(unwrapCdc(kv.key))] = unwrapCdc(kv.value)
        return out
      }
      case 'Struct':
      case 'Resource':
      case 'Event':
      case 'Contract':
      case 'Enum': {
        const out = {}
        const fields = value.fields ?? []
        for (const f of fields) out[f.name] = unwrapCdc(f.value)
        return out
      }
      case 'Type':
        return { staticType: value.staticType }
      default:
        return value
    }
  }
  return node
}

function extractStorefrontAddress(evt) {
  try {
    const raw = JSON.parse(Buffer.from(evt.payload, 'base64').toString('utf8'))
    const payload = unwrapCdc(raw)
    const addr = payload?.storefrontAddress
    if (typeof addr !== 'string') return null
    return addr.toLowerCase()
  } catch {
    return null
  }
}

/* ── Flow events fetch with AbortController timeout ─────────────── */

async function fetchEvents(node, start, end) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS)
  try {
    const url = `${node.url}/v1/events?type=${encodeURIComponent(EVENT_TYPE)}&start_height=${start}&end_height=${end}`
    const res = await fetch(url, { signal: ac.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

/* ── main ───────────────────────────────────────────────────────── */

async function writeCheckpoint(block) {
  const { error } = await supabase
    .from('scan_checkpoint')
    .upsert(
      { key: CHECKPOINT_KEY, block_height: block, updated_at: new Date().toISOString() },
      { onConflict: 'key' }
    )
  if (error) console.log(`[checkpoint] write error: ${error.message}`)
}

async function main() {
  console.log(`[scan-historical-storefront] DRY_RUN=${DRY_RUN}`)

  const { data: ckpt, error: ckptErr } = await supabase
    .from('scan_checkpoint')
    .select('block_height')
    .eq('key', CHECKPOINT_KEY)
    .maybeSingle()

  if (ckptErr) {
    console.error('Failed to read scan_checkpoint:', ckptErr)
    process.exit(1)
  }

  const resumeFrom = Math.max(Number(ckpt?.block_height ?? 0), START_BLOCK)

  if (resumeFrom >= FINAL_BLOCK) {
    console.log('Historical scan complete')
    return
  }

  console.log(
    `[scan-historical-storefront] resume=${resumeFrom} target=${FINAL_BLOCK} ` +
      `(${(FINAL_BLOCK - resumeFrom).toLocaleString()} blocks remaining)`
  )

  const addresses = new Set()
  let cursor = resumeFrom
  let chunksProcessed = 0
  let totalAddresses = 0
  let totalEvents = 0

  async function flush() {
    if (addresses.size === 0) {
      const pct = (((cursor - START_BLOCK) / (FINAL_BLOCK - START_BLOCK)) * 100).toFixed(2)
      console.log(`[progress] ${pct}% cursor=${cursor} chunks=${chunksProcessed} (no new addrs)`)
      return
    }
    const rows = [...addresses].map((a) => ({ address: a }))
    totalAddresses += rows.length

    if (DRY_RUN) {
      console.log(`[flush] would upsert ${rows.length} address(es) (dry-run)`)
    } else {
      const { error } = await supabase
        .from('storefront_audit_wallets')
        .upsert(rows, { onConflict: 'address', ignoreDuplicates: true })
      if (error) console.log(`[flush] upsert error: ${error.message}`)
      await writeCheckpoint(cursor)
    }

    const pct = (((cursor - START_BLOCK) / (FINAL_BLOCK - START_BLOCK)) * 100).toFixed(2)
    console.log(
      `[progress] ${pct}% cursor=${cursor} chunks=${chunksProcessed} ` +
        `+${rows.length} addrs (total=${totalAddresses}, events=${totalEvents})`
    )
    addresses.clear()
  }

  while (cursor < FINAL_BLOCK) {
    const start = cursor + 1
    const node = nodeForBlock(start)
    if (!node) {
      console.log(`[chunk] no spork node covers block ${start}; stopping`)
      break
    }
    const end = Math.min(start + CHUNK_SIZE - 1, node.maxBlock, FINAL_BLOCK)

    try {
      const blocks = await fetchEvents(node, start, end)
      for (const blk of blocks) {
        for (const evt of blk.events ?? []) {
          totalEvents++
          const addr = extractStorefrontAddress(evt)
          if (addr) addresses.add(addr)
        }
      }
    } catch (err) {
      console.log(
        `[chunk ${start}-${end} @ mainnet${node.id}] error: ${err?.message || err}`
      )
    }

    cursor = end
    chunksProcessed++

    if (!DRY_RUN) {
      await writeCheckpoint(cursor)
    }

    if (chunksProcessed % FLUSH_EVERY_N_CHUNKS === 0) {
      await flush()
    }

    await sleep(DELAY_MS)
  }

  await flush()

  console.log('\n=== Summary ===')
  console.log(`Chunks processed: ${chunksProcessed}`)
  console.log(`Events seen: ${totalEvents}`)
  console.log(`Unique addresses upserted: ${totalAddresses}`)
  console.log(`Final cursor: ${cursor}`)
}

main().catch((err) => {
  console.error('Fatal:', err)
  process.exit(1)
})
