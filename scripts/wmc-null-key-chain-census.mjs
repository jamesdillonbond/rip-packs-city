#!/usr/bin/env node
/**
 * One chain verdict per Top Shot wallet_moments_cache row whose edition_key IS NULL,
 * written to public.audit_20260929_wmc_null_key_chain_census.
 *
 * WHY (2026-09-29): /api/wallet-search served All Day requests by reading the wallet's
 * ALL DAY ids and writing them into the TOP SHOT cache as nameless NULL-key rows. A
 * moment id is unique only within a collection (#142), so the only honest test of a
 * NULL-key Top Shot row is to ask the chain where that id lives in the stored wallet:
 *   ts   — in the wallet's Top Shot collection (a real, unnamed Top Shot holding: keep)
 *   ad   — in its All Day collection only (the defect)
 *   both — in both collections
 *   none — in neither (moved since)
 * ⚠ A Top-Shot-only read (the first diagnosis) sees "not there" and cannot tell
 * All Day from phantom. Read both collections.
 *
 * USAGE
 *   NEXT_PUBLIC_SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… node scripts/wmc-null-key-chain-census.mjs
 * Exit: 0 wrote every row · 1 a write failed · 2 could not read.
 */
import * as fcl from '@onflow/fcl'
import { createClient } from '@supabase/supabase-js'

const TS = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
const CENSUS = 'audit_20260929_wmc_null_key_chain_census'

fcl.config().put('accessNode.api', 'https://rest-mainnet.onflow.org')
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

// PostgREST clamps every read at 1,000 rows — page on the unique id.
const rows = []
for (let from = 0; ; from += 1000) {
  const { data, error } = await sb
    .from('wallet_moments_cache')
    .select('id,wallet_address,moment_id')
    .eq('collection_id', TS)
    .is('edition_key', null)
    .order('id')
    .range(from, from + 999)
  if (error) { console.error('read failed:', error.message); process.exit(2) }
  rows.push(...data)
  if (data.length < 1000) break
}

const cadence = `
import TopShot from 0x0b2a3299cc857e29
import AllDay from 0xe4cf4bdc1751c65d
access(all) fun main(addr: Address, ids: [UInt64]): [String] {
  let a = getAccount(addr)
  let tc = a.capabilities.borrow<&{TopShot.MomentCollectionPublic}>(/public/MomentCollection)
  let ac = a.capabilities.borrow<&{AllDay.MomentNFTCollectionPublic}>(/public/AllDayNFTCollection)
  let out: [String] = []
  for id in ids {
    let ts = tc != nil && tc!.borrowMoment(id: id) != nil
    let ad = ac != nil && ac!.borrowNFT(id) != nil
    out.append(ts ? (ad ? "both" : "ts") : (ad ? "ad" : "none"))
  }
  return out
}`

const byWallet = new Map()
for (const r of rows) {
  if (!byWallet.has(r.wallet_address)) byWallet.set(r.wallet_address, [])
  byWallet.get(r.wallet_address).push(r)
}

const verdicts = []
for (const [wallet, list] of byWallet) {
  let res
  try {
    res = await fcl.query({
      cadence,
      args: (arg, t) => [arg(wallet, t.Address), arg(list.map((r) => String(r.moment_id)), t.Array(t.UInt64))],
    })
  } catch (e) {
    console.error(`chain read failed for ${wallet}:`, e instanceof Error ? e.message : String(e))
    process.exit(2)
  }
  if (!Array.isArray(res) || res.length !== list.length) {
    console.error(`chain read for ${wallet} returned ${res?.length} verdicts for ${list.length} ids`)
    process.exit(2)
  }
  list.forEach((r, i) => verdicts.push({ id: r.id, wallet_address: r.wallet_address, moment_id: String(r.moment_id), chain: res[i] }))
}

let written = 0
for (let i = 0; i < verdicts.length; i += 500) {
  const chunk = verdicts.slice(i, i + 500)
  const { error } = await sb.from(CENSUS).upsert(chunk, { onConflict: 'id' })
  if (error) { console.error('census write failed:', error.message); process.exit(1) }
  written += chunk.length
}

const tally = {}
for (const v of verdicts) tally[v.chain] = (tally[v.chain] ?? 0) + 1
console.log(`read ${rows.length} rows / ${byWallet.size} wallets · wrote ${written} verdicts ·`, tally)
