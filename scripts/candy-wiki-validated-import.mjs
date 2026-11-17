#!/usr/bin/env node
// scripts/candy-wiki-validated-import.mjs — ONE-TIME import of Magic Eden Candy sales that the
// collections-market lane cannot reach (older than ME's activity feed, or beyond its page cap).
//
// Provenance (Trevor 2026-11-14 7:55 PM PT): the DC3 Wiki sold explorer is acceptable as an
// initial DISCOVERY source only; every sale must be validated against official sources before
// it enters RPC. The two files under scripts/candy-wiki-validated/ were produced by the
// Cowork session of 2026-11-14 (Project doc claude/handoff-2026-11-14-candy-fmv-coverage-gap.md):
//   · candy-wiki-validated-me-sales.jsonl        — 736 rows validated against Magic Eden's own
//     per-token activity API (signature, token mint, sale type, price, block time all matched);
//   · candy-wiki-validated-me-sales-chain.jsonl  — 1,849 rows validated on chain as Magic Eden M2
//     buys (validated_by solana_chain_me_m2_buy_1.12x).
// Committed 2026-11-15 by Claude Code cloud for inbox 2026-11-15T0500Z step 6 (the files were
// Project-only, so no session with the service-role key could read them).
//
// It does NOT write `sales`. Each row is OFFERED to candy_sales_unresolved through
// candy_park_unresolved_sale(..., 'queued_collections_walk') — exactly what
// lib/candy/collections-market.ts does — so the candy-sales-indexer drain stays the ONE writer:
// it re-resolves the edition from the asset (DAS), prices on the trade day's sol_usd_daily rate,
// and writes marketplace 'magic_eden'. ⚠ OpenSea rows must NEVER go through here: the drain
// hardcodes marketplace 'magic_eden'. The script refuses any row whose venue is not magic_eden.
//
// Dedupe is EXACT and server-side, same as the lane: a signature already in Candy `sales` or in
// candy_sales_unresolved is skipped (the park RPC would count a re-offer as a failed attempt).
//
// Usage (needs the service-role key; nothing is written without --apply):
//   SUPABASE_URL=… SUPABASE_SERVICE_ROLE_KEY=… node scripts/candy-wiki-validated-import.mjs <file.jsonl>
//   … --apply
// Runner: .github/workflows/candy-wiki-validated-import.yml (workflow_dispatch, apply=false by default).
// Revert (before the drain writes them):
//   DELETE FROM candy_sales_unresolved WHERE resolved_at IS NULL AND signature IN (<file signatures>);
// After the drain writes them: the sales rows carry these transaction_hash values — back them up to an
// audit_ table first, then delete by transaction_hash, then let fmv-recalc re-price.

import { readFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { createClient } from "@supabase/supabase-js"

const CANDY_MLB_UUID = "209ade70-32c5-4470-bc7c-4793d660f713"
const QUEUE_REASON = "queued_collections_walk"
const B58 = /^[1-9A-HJ-NP-Za-km-z]+$/

const [file, ...flags] = process.argv.slice(2)
const APPLY = flags.includes("--apply")
if (!file) { console.error("usage: candy-wiki-validated-import.mjs <file.jsonl> [--apply]"); process.exit(2) }
const url = process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) { console.error("SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY are required"); process.exit(2) }

const raw = readFileSync(file, "utf8")
console.log(`file ${file} sha256 ${createHash("sha256").update(raw).digest("hex")} bytes ${raw.length}`)

// ── Parse + shape-check every row; refuse the whole file on any defect (no partial import). ──
const rows = []
const seen = new Set()
raw.split("\n").filter(Boolean).forEach((line, i) => {
  const r = JSON.parse(line)
  const bad = (m) => { throw new Error(`line ${i + 1}: ${m}`) }
  if (r.status !== "valid") bad(`status ${r.status} (only validated rows belong in this file)`)
  if (r.venue !== "magic_eden") bad(`venue ${r.venue} — OpenSea rows must not use the Magic Eden queue`)
  if (typeof r.sig !== "string" || r.sig.length < 80 || r.sig.length > 90 || !B58.test(r.sig)) bad("signature shape")
  if (typeof r.mint !== "string" || r.mint.length < 32 || r.mint.length > 44 || !B58.test(r.mint)) bad("mint shape")
  if (!(typeof r.price_sol === "number" && r.price_sol > 0)) bad("price_sol")
  if (!(Number.isInteger(r.block_time) && r.block_time > 1782864000 && r.block_time < 1794700000)) bad("block_time outside 2026-07-01..2026-11-15")
  for (const k of ["buyer", "seller"]) if (r[k] != null && !(typeof r[k] === "string" && B58.test(r[k]))) bad(`${k} shape`)
  const id = `${r.sig}:${r.mint}`
  if (seen.has(id)) bad("duplicate signature+mint in file")
  seen.add(id)
  rows.push(r)
})
console.log(`rows ${rows.length} (all validated, all magic_eden)`)

const db = createClient(url, key, { auth: { persistSession: false } })

// ── Exact dedupe against Candy `sales` and the park queue, 50 signatures per read (200 x ~88-char signatures overflowed the request URL: "fetch failed", run 43733709210). ──
const known = new Set()
const sigs = [...new Set(rows.map((r) => r.sig))]
for (let i = 0; i < sigs.length; i += 50) {
  const chunk = sigs.slice(i, i + 50)
  const q = await db.from("candy_sales_unresolved").select("signature").in("signature", chunk)
  if (q.error) throw new Error(`queue read: ${q.error.message}`)
  for (const r of q.data ?? []) known.add(r.signature)
  const s = await db.from("sales").select("transaction_hash").eq("collection_id", CANDY_MLB_UUID).in("transaction_hash", chunk)
  if (s.error) throw new Error(`sales read: ${s.error.message}`)
  for (const r of s.data ?? []) known.add(r.transaction_hash)
}
const todo = rows.filter((r) => !known.has(r.sig))
console.log(`already in RPC (sales or queue): ${rows.length - todo.length}; to park: ${todo.length}`)
if (!APPLY) { console.log("dry run — re-run with --apply to park"); process.exit(0) }

// ── Park through the lane's own RPC. A failed park is counted and printed, never swallowed. ──
let parked = 0
const failed = []
for (const r of todo) {
  const { error } = await db.rpc("candy_park_unresolved_sale", {
    p_signature: r.sig,
    p_token_mint: r.mint,
    p_block_time: new Date(r.block_time * 1000).toISOString(),
    p_price_sol: r.price_sol,
    p_buyer: r.buyer ?? null,
    p_seller: r.seller ?? null,
    p_skip_reason: QUEUE_REASON,
  })
  if (error) failed.push(`${r.sig.slice(0, 12)}…: ${error.message}`)
  else parked++
}
console.log(`parked ${parked}; failed ${failed.length}`)
for (const f of failed.slice(0, 20)) console.log(`  ${f}`)
process.exit(failed.length ? 1 : 0)
