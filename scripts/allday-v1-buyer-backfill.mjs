#!/usr/bin/env node
/**
 * All Day V1 buyer backfill (register #161, 2026-09-30).
 *
 * Trevor: "Buybacks should still count as market sales on both, but should be
 * tracked additionally." A buyback is tracked by its BUYER (the AllDay issuer
 * 0xe4cf4bdc1751c65d), but the multi-NFT price pass (09-29) wrote no buyer, so
 * those rows reach `sales` with buyer NULL and cannot be identified.
 *
 * For every target row this reads the tx from Flow REST and takes the
 * `AllDay.Deposit.to` of THAT nft. It writes the buyer only when:
 *   - exactly one Deposit of the nft is in the tx (else ambiguous → skipped),
 *   - the target is not a custodian (`0xddfbe848a81b2236` re-forwards; those
 *     rows stay NULL on purpose — lib/chains/flow/dapper-v1-tx-decode.ts),
 *   - the row's buyer is still NULL at write time (`.is('buyer_address', null)`).
 * It never overwrites a buyer.
 *
 * Targets:
 *   unmapped_sales  All Day, price_source = v1_multi_nft_segment, buyer NULL
 *   sales           All Day, source = onchain_dapper_v1, buyer NULL
 *
 * Every write is recorded in public.audit_20260930_allday_v1_buyer_backfill
 * BEFORE the update, so the revert is exact:
 *   UPDATE public.sales s SET buyer_address = NULL FROM public.audit_20260930_allday_v1_buyer_backfill a
 *    WHERE a.tbl = 'sales' AND s.id = a.row_id AND s.buyer_address = a.buyer;
 *   (and the same for unmapped_sales)
 *
 * Usage (dry run is the default; --apply writes):
 *   node --env-file=.env.local scripts/allday-v1-buyer-backfill.mjs [--apply] [--max-txs N]
 */
import { createClient } from '@supabase/supabase-js'

const ALLDAY = 'dee28451-5d62-409e-a1ad-a83f763ac070'
const DEPOSIT = 'A.e4cf4bdc1751c65d.AllDay.Deposit'
const CUSTODIAL = new Set(['ddfbe848a81b2236'])
const FLOW = 'https://rest-mainnet.onflow.org'
const APPLY = process.argv.includes('--apply')
const maxIdx = process.argv.indexOf('--max-txs')
const MAX_TXS = maxIdx > 0 ? Number(process.argv[maxIdx + 1]) : Infinity
const onlyIdx = process.argv.indexOf('--only')
const ONLY = onlyIdx > 0 ? process.argv[onlyIdx + 1] : null // 'sales' | 'unmapped_sales'
const PACE_MS = 200 // ~5 req/s: the Flow REST budget is shared with the every-minute lanes

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
const norm = (a) => String(a ?? '').toLowerCase().replace(/^0x/, '')

async function loadTargets(table, filter) {
  const rows = []
  // Keyset on the unique id: OFFSET paging timed out at offset 10,000 on `sales`.
  let after = null
  for (;;) {
    let q = sb.from(table).select('id, nft_id, transaction_hash').eq('collection_id', ALLDAY).is('buyer_address', null)
    if (after) q = q.gt('id', after)
    q = filter(q).order('id', { ascending: true }).limit(1000)
    const { data, error } = await q
    // A failed page must not yield a partial list that reads as complete.
    if (error) throw new Error(`${table} after ${after}: ${error.message}`)
    rows.push(...data.map((r) => ({ ...r, tbl: table })))
    if (data.length < 1000) break
    after = data[data.length - 1].id
  }
  return rows
}

function decodeDeposits(events, nftId) {
  const tos = []
  for (const e of events) {
    if (e.type !== DEPOSIT) continue
    let p
    try { p = JSON.parse(Buffer.from(e.payload, 'base64').toString('utf8')) } catch { continue }
    const f = Object.fromEntries((p?.value?.fields ?? []).map((x) => [x.name, x.value]))
    const id = String(f.id?.value ?? '')
    let to = f.to
    while (to && typeof to === 'object' && 'value' in to && to.type === 'Optional') to = to.value
    const addr = to && typeof to === 'object' ? to.value : to
    if (id === String(nftId) && addr) tos.push(norm(addr))
  }
  return tos
}

async function fetchEvents(tx) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(`${FLOW}/v1/transaction_results/${tx.replace(/^0x/, '')}`, { signal: AbortSignal.timeout(10000) })
      if (r.status === 429) { await new Promise((s) => setTimeout(s, 2000 * (attempt + 1))); continue }
      if (!r.ok) return { error: `http_${r.status}` }
      return { events: (await r.json()).events ?? [] }
    } catch {
      if (attempt === 2) return { error: 'fetch_failed' }
    }
  }
  return { error: 'http_429' }
}

// `sales` is partitioned by year and has no index serving (collection, buyer NULL, source)
// in id order, so a table-wide keyset page re-ran a collection-wide bitmap scan and hit the
// statement timeout. Walk one DAY at a time on (collection_id, sold_at) instead, keyset by id
// inside the day (a day can exceed 1,000 rows: 1,150 measured).
async function loadSalesByDay(firstDay) {
  const rows = []
  const end = Date.now() + 86400000
  for (let t = Date.parse(firstDay); t < end; t += 86400000) {
    const lo = new Date(t).toISOString()
    const hi = new Date(t + 86400000).toISOString()
    let after = null
    for (;;) {
      let q = sb.from('sales').select('id, nft_id, transaction_hash')
        .eq('collection_id', ALLDAY).gte('sold_at', lo).lt('sold_at', hi)
        .is('buyer_address', null).eq('source', 'onchain_dapper_v1')
      if (after) q = q.gt('id', after)
      const { data, error } = await q.order('id', { ascending: true }).limit(1000)
      if (error) throw new Error(`sales ${lo.slice(0, 10)} after ${after}: ${error.message}`)
      rows.push(...data.map((r) => ({ ...r, tbl: 'sales' })))
      if (data.length < 1000) break
      after = data[data.length - 1].id
    }
  }
  return rows
}

const targets = [
  ...(ONLY && ONLY !== 'unmapped_sales' ? [] : await loadTargets('unmapped_sales', (q) => q.eq('resolution_hint->>price_source', 'v1_multi_nft_segment'))),
  ...(ONLY && ONLY !== 'sales' ? [] : await loadSalesByDay('2025-12-29T00:00:00Z')),
]
const byTx = new Map()
for (const r of targets) {
  if (!r.transaction_hash) continue
  const a = byTx.get(r.transaction_hash) ?? []
  a.push(r)
  byTx.set(r.transaction_hash, a)
}
console.log(`targets: ${targets.length} rows in ${byTx.size} txs (unmapped ${targets.filter((r) => r.tbl === 'unmapped_sales').length}, sales ${targets.filter((r) => r.tbl === 'sales').length}) mode=${APPLY ? 'APPLY' : 'dry-run'}`)

const stats = { txs: 0, tx_errors: {}, rows_resolved: 0, custodial: 0, ambiguous: 0, no_deposit: 0, written: 0, write_errors: 0, audit_errors: 0, by_buyer: {} }
const pending = [] // { tbl, row_id, buyer }

async function flush() {
  if (!APPLY || pending.length === 0) return
  const batch = pending.splice(0)
  const { error: aErr } = await sb.from('audit_20260930_allday_v1_buyer_backfill').insert(batch)
  if (aErr) { stats.audit_errors += batch.length; console.log(`audit insert failed, NOT writing ${batch.length}: ${aErr.message}`); return }
  const groups = new Map()
  for (const b of batch) {
    const k = `${b.tbl}|${b.buyer}`
    const g = groups.get(k) ?? []
    g.push(b.row_id)
    groups.set(k, g)
  }
  for (const [k, ids] of groups) {
    const [tbl, buyer] = k.split('|')
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200)
      const { data, error } = await sb.from(tbl).update({ buyer_address: buyer }).in('id', chunk).is('buyer_address', null).select('id')
      if (error) { stats.write_errors += chunk.length; console.log(`update ${tbl} failed: ${error.message}`); continue }
      stats.written += data.length // rows WRITTEN, not rows offered
    }
  }
}

for (const [tx, rows] of byTx) {
  if (stats.txs >= MAX_TXS) break
  stats.txs++
  const res = await fetchEvents(tx)
  await new Promise((s) => setTimeout(s, PACE_MS))
  if (res.error) { stats.tx_errors[res.error] = (stats.tx_errors[res.error] ?? 0) + 1; continue }
  for (const r of rows) {
    const tos = decodeDeposits(res.events, r.nft_id)
    if (tos.length === 0) { stats.no_deposit++; continue }
    if (new Set(tos).size > 1) { stats.ambiguous++; continue }
    const to = tos[0]
    if (CUSTODIAL.has(to)) { stats.custodial++; continue }
    stats.rows_resolved++
    const buyer = `0x${to}`
    stats.by_buyer[buyer] = (stats.by_buyer[buyer] ?? 0) + 1
    pending.push({ tbl: r.tbl, row_id: r.id, buyer })
  }
  if (pending.length >= 500) await flush()
  if (stats.txs % 500 === 0) console.log(`progress ${stats.txs}/${byTx.size} resolved=${stats.rows_resolved} written=${stats.written} no_deposit=${stats.no_deposit} custodial=${stats.custodial} tx_errors=${JSON.stringify(stats.tx_errors)}`)
}
await flush()

const top = Object.entries(stats.by_buyer).sort((a, b) => b[1] - a[1]).slice(0, 8)
console.log(JSON.stringify({ ...stats, by_buyer: Object.fromEntries(top), distinct_buyers: Object.keys(stats.by_buyer).length }, null, 1))
if (stats.write_errors || stats.audit_errors) process.exit(1)
