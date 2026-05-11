#!/usr/bin/env node
// scripts/backfill-ts-serial-zero-sales.mjs
//
// One-shot recovery for TopShot sales rows with serial_number=0 that landed
// between 2026-04-10 (regression start, broader than the prompt's 2026-04-22)
// and 2026-05-06 (last broken row). Trigger commit for the regression's fix
// is 55566e3 — see docs/audits/ts-trait-regression-rootcause.md.
//
// Resolution path: query Top Shot GraphQL `getMintedMoment(momentId)` for
// each sale row's nft_id and pull `flowSerialNumber`. This mirrors the
// GQL-fallback path the live sales-indexer uses (app/api/sales-indexer/route.ts
// :402). Calls are routed through the topshot-proxy Cloudflare Worker because
// Top Shot's public-api blocks egress from Vercel / GH Actions / residential.
//
// Rows whose moment is unrecoverable on-chain (deleted/burned, returned null
// data) are left at serial_number=0 and their nft_ids are emitted into
// pipeline_runs.extra.unrecoverable_nft_ids for honest accounting. The
// `sales` table has no `metadata` column (verified against
// information_schema.columns 2026-05-11), so the prompt's
// `metadata->>'serial_zero_unrecoverable'` proposal cannot land — logging
// per-row in pipeline_runs.extra is the next-best paper trail.
//
// Batched in chunks of 200 with a 1-second sleep between batches so this
// doesn't compete with the wallet-backfill orchestrator (Item 1) for the
// Supabase connection pool.
//
// Usage:
//   node scripts/backfill-ts-serial-zero-sales.mjs --dry-run   (first 20, no writes)
//   node scripts/backfill-ts-serial-zero-sales.mjs             (full run)

import { readFileSync } from 'fs'
import { resolve } from 'path'
import { createClient } from '@supabase/supabase-js'

function loadEnv() {
  const envPath = resolve(process.cwd(), '.env.local')
  try {
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
    // .env.local optional when env vars come from the shell
  }
}
loadEnv()

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const TS_PROXY_URL = process.env.TS_PROXY_URL || 'https://topshot-proxy.tdillonbond.workers.dev/'
const TS_PROXY_SECRET = process.env.TS_PROXY_SECRET

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}
if (!TS_PROXY_SECRET) {
  console.error('Missing TS_PROXY_SECRET (required by topshot-proxy)')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
})

const NBA_TOP_SHOT_UUID = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
const WINDOW_START = '2026-04-10T00:00:00Z'
const WINDOW_END   = '2026-05-07T00:00:00Z'
const BATCH_SIZE = 200
const PER_REQUEST_DELAY_MS = 150
const BATCH_SLEEP_MS = 1000
const DRY_RUN = process.argv.includes('--dry-run')
const PIPELINE_NAME = 'backfill-ts-serial-zero'

const GQL_QUERY = 'query($id:ID!){getMintedMoment(momentId:$id){data{...on MintedMoment{flowSerialNumber}}}}'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function resolveSerialViaGql(nftId) {
  try {
    const resp = await fetch(TS_PROXY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Proxy-Secret': TS_PROXY_SECRET,
      },
      body: JSON.stringify({ query: GQL_QUERY, variables: { id: nftId } }),
    })
    if (!resp.ok) return { ok: false, reason: `HTTP ${resp.status}` }
    const json = await resp.json()
    const raw = json?.data?.getMintedMoment?.data?.flowSerialNumber
    if (raw == null) return { ok: false, reason: 'null_moment_data' }
    const n = Number(raw)
    if (!Number.isFinite(n) || n <= 0) return { ok: false, reason: 'non_positive_serial' }
    return { ok: true, serial: n }
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : String(err) }
  }
}

async function loadOffending() {
  // sales is partitioned; PostgREST hits the parent table.
  const { data, error } = await supabase
    .from('sales')
    .select('id, nft_id, sold_at')
    .eq('collection_id', NBA_TOP_SHOT_UUID)
    .eq('serial_number', 0)
    .gte('sold_at', WINDOW_START)
    .lt('sold_at', WINDOW_END)
    .order('sold_at', { ascending: true })
    .limit(10000)
  if (error) throw new Error(`load failed: ${error.message}`)
  return data ?? []
}

async function main() {
  const startedAt = new Date().toISOString()
  const t0 = Date.now()
  console.log(`[backfill-ts-serial-zero] ${DRY_RUN ? 'DRY RUN — ' : ''}window=${WINDOW_START}..${WINDOW_END}`)

  const rows = await loadOffending()
  console.log(`[backfill-ts-serial-zero] loaded ${rows.length} candidate rows`)
  const work = DRY_RUN ? rows.slice(0, 20) : rows

  let updated = 0
  let unrecoverable = 0
  let errors = 0
  const unrecoverableNftIds = []
  const errorSamples = []

  for (let batchStart = 0; batchStart < work.length; batchStart += BATCH_SIZE) {
    const batch = work.slice(batchStart, batchStart + BATCH_SIZE)
    console.log(
      `[backfill-ts-serial-zero] batch ${Math.floor(batchStart / BATCH_SIZE) + 1}/${Math.ceil(work.length / BATCH_SIZE)} ` +
      `(rows ${batchStart}..${batchStart + batch.length})`
    )

    for (const row of batch) {
      const nftId = row.nft_id
      if (!nftId) {
        unrecoverable++
        continue
      }
      const result = await resolveSerialViaGql(String(nftId))
      if (!result.ok) {
        if (result.reason === 'null_moment_data' || result.reason === 'non_positive_serial') {
          unrecoverable++
          if (unrecoverableNftIds.length < 200) unrecoverableNftIds.push(nftId)
        } else {
          errors++
          if (errorSamples.length < 20) errorSamples.push({ nft_id: nftId, reason: result.reason })
        }
        await sleep(PER_REQUEST_DELAY_MS)
        continue
      }

      if (DRY_RUN) {
        console.log(`  [dry] would set ${row.id} (nft=${nftId}) serial=${result.serial}`)
        updated++
      } else {
        const { error } = await supabase
          .from('sales')
          .update({ serial_number: result.serial })
          .eq('id', row.id)
        if (error) {
          errors++
          if (errorSamples.length < 20) errorSamples.push({ nft_id: nftId, reason: `update: ${error.message}` })
        } else {
          updated++
        }
      }

      await sleep(PER_REQUEST_DELAY_MS)
    }

    if (batchStart + BATCH_SIZE < work.length) {
      await sleep(BATCH_SLEEP_MS)
    }
  }

  const elapsedMs = Date.now() - t0
  const recoveryRate = work.length > 0 ? (updated / work.length) * 100 : 0
  console.log(
    `[backfill-ts-serial-zero] done in ${(elapsedMs / 1000).toFixed(1)}s — ` +
    `updated=${updated} unrecoverable=${unrecoverable} errors=${errors} ` +
    `recovery_rate=${recoveryRate.toFixed(2)}%`
  )

  if (!DRY_RUN) {
    const { error: logErr } = await supabase.rpc('log_pipeline_run', {
      p_pipeline: PIPELINE_NAME,
      p_started_at: startedAt,
      p_rows_found: work.length,
      p_rows_written: updated,
      p_rows_skipped: unrecoverable,
      p_ok: errors === 0,
      p_error: errors > 0 ? `${errors} errors` : null,
      p_collection_slug: 'nba_top_shot',
      p_cursor_before: null,
      p_cursor_after: null,
      p_extra: {
        window_start: WINDOW_START,
        window_end: WINDOW_END,
        recovery_rate_pct: Number(recoveryRate.toFixed(2)),
        unrecoverable_nft_ids: unrecoverableNftIds,
        error_samples: errorSamples,
        elapsed_ms: elapsedMs,
      },
    })
    if (logErr) console.log(`[backfill-ts-serial-zero] log_pipeline_run err: ${logErr.message}`)
  }
}

main().catch((err) => {
  console.error('[backfill-ts-serial-zero] fatal:', err)
  process.exit(1)
})
