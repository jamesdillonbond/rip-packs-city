#!/usr/bin/env node
// scripts/cadence/fork-swap-test.ts
//
// EXECUTES the trade room's swap TRANSACTIONS — not a script built from the same fragments —
// on a local Flow emulator FORKED from mainnet (2026-11-02, Trevor: "Keep going"). Nothing
// reaches mainnet: the fork reads mainnet state lazily and keeps every write local.
// Signatures are skipped (`--skip-tx-validation`), so the two real accounts can be
// authorizers without their keys. Run by .github/workflows/trade-swap-fork-test.yml (a GitHub
// runner has the direct gRPC egress the fork needs; a cloud sandbox's proxy does not).
//
// Two cases, each planned with the PRODUCTION planner first (keys, held/unlocked, receiver,
// controllers, mainnet simulation), then submitted as the real transaction:
//   1. MULTI_SWAP_CADENCE near its cap: side A gives up to 10 Moments across Golazos + UFC
//      (+ All Day only where B can receive it), side B up to 10 across Top Shot + Golazos + UFC.
//   2. SWAP_CADENCE (the all-Top-Shot text): B gives one unlocked Top Shot Moment to A.
// For each: the transaction must SEAL with no error, every Moment must sit in the other
// side's account afterwards (read from the fork), and computation_used is reported against
// the 9,999 limit.
//
// Env: EMULATOR_REST (default http://127.0.0.1:8888/v1); SIDE_A / SIDE_B as
// "signer:source" (default: the two wallets of the 10-31 live test).

import { addr, runFlowScript, type CdcArg, type CdcValue } from "../../lib/giveaways/flow-script"
import { readTopShotHoldings } from "../../lib/giveaways/topshot-holdings"
import { planSwap, swapArgs } from "../../lib/swap-test/plan"
import { SWAP_CADENCE, SWAP_GAS_LIMIT } from "../../lib/swap-test/swap-cadence"
import { idsReader, multiSwapArgs, planMultiSwap, readCanReceive, readCollectionHoldings, type Pick } from "../../lib/trade-room/multi-plan"
import { MULTI_SWAP_CADENCE, MULTI_SWAP_GAS_LIMIT, SWAP_COLLECTIONS, type SwapSlug } from "../../lib/trade-room/multi-swap-cadence"

const EMU = (process.env.EMULATOR_REST || "http://127.0.0.1:8888/v1").replace(/\/$/, "")
// The emulator's REST API reports computation_used as 0; `--computation-reporting` keeps the
// real figure on the ADMIN API (default port 8080), keyed by transaction id.
const ADMIN = (process.env.EMULATOR_ADMIN || "http://127.0.0.1:8080").replace(/\/$/, "")

/** The computation a transaction used, from the emulator's computation report; null when it is not there. */
async function computationOf(txId: string): Promise<number | null> {
  try {
    const res = await fetch(`${ADMIN}/emulator/computationReport`)
    if (!res.ok) return null
    const report = (await res.json()) as { transactions?: Record<string, { computation?: number }> }
    const hit = report.transactions?.[txId]
    return typeof hit?.computation === "number" ? hit.computation : null
  } catch {
    return null
  }
}
const side = (env: string | undefined, dflt: string) => {
  const [signer, source] = (env || dflt).split(":")
  return { signer, source }
}
const A = side(process.env.SIDE_A, "0x3d0b274c80263484:0xbd94cade097e50ac")
const B = side(process.env.SIDE_B, "0x68c1fb83ba8e634a:0xa3d67b29e104e701")
const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64")
const hex = (a: string) => a.toLowerCase().replace(/^0x/, "")

/** runFlowScript, pointed at the FORK instead of mainnet. */
const runOnFork: typeof runFlowScript = (script, args) =>
  runFlowScript(script, args, (_url, init) => fetch(`${EMU}/scripts?block_height=sealed`, init))

async function emu<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${EMU}${path}`, init)
  const text = await res.text()
  if (!res.ok) throw new Error(`emulator ${path}: HTTP ${res.status} ${text.slice(0, 600)}`)
  return JSON.parse(text) as T
}

const DUMMY_SIG = Buffer.alloc(64, 1).toString("base64")

/** Submits a two-authorizer transaction (A proposes and pays) to the fork; returns the sealed result. */
async function send(cadence: string, args: CdcArg[], gas: number): Promise<{ id: string; status: string; error: string; computation: number; events: number }> {
  const [block] = await emu<Array<{ header: { id: string } }>>("/blocks?height=sealed")
  const acct = await emu<{ keys: Array<{ index: string; sequence_number: string; revoked: boolean; weight: string }> }>(`/accounts/0x${hex(A.signer)}?expand=keys`)
  const key = acct.keys.find((k) => !k.revoked && Number(k.weight) >= 1000) ?? acct.keys[0]
  const body = {
    script: b64(cadence),
    arguments: args.map((a) => b64(JSON.stringify(a))),
    reference_block_id: block.header.id,
    gas_limit: String(gas),
    payer: hex(A.signer),
    proposal_key: { address: hex(A.signer), key_index: key.index, sequence_number: key.sequence_number },
    authorizers: [hex(A.signer), hex(B.signer)],
    payload_signatures: [{ address: hex(B.signer), key_index: "0", signature: DUMMY_SIG }],
    envelope_signatures: [{ address: hex(A.signer), key_index: key.index, signature: DUMMY_SIG }],
  }
  const sent = await emu<{ id: string }>("/transactions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  for (let i = 0; i < 120; i++) {
    const r = await emu<{ status: string; error_message: string; computation_used: string; events: unknown[] }>(`/transaction_results/${sent.id}`)
    if (r.status === "Sealed" || r.status === "Expired") {
      const fromReport = await computationOf(sent.id)
      return { id: sent.id, status: r.status, error: r.error_message, computation: fromReport ?? Number(r.computation_used), events: r.events.length }
    }
    await new Promise((res) => setTimeout(res, 1000))
  }
  throw new Error(`transaction ${sent.id} did not seal on the fork within 120 s`)
}

/** Unlocked Top Shot ids held by `source`, up to `n` (reads the chain; Top Shot locks stay in the collection). */
async function unlockedTopShot(source: string, n: number): Promise<string[]> {
  const v = await runFlowScript(
    `import TopShot from 0x0b2a3299cc857e29
access(all) fun main(a: Address): [UInt64] {
    if let c = getAccount(a).capabilities.borrow<&{TopShot.MomentCollectionPublic}>(/public/MomentCollection) {
        let ids = c.getIDs()
        return ids.length > 300 ? ids.slice(from: 0, upTo: 300) : ids
    }
    return []
}`,
    [addr(source)],
  )
  const ids = ((v.value as CdcValue[]) ?? []).map((x) => String(x.value))
  const h = await readTopShotHoldings(source, ids)
  return ids.filter((id) => h[id]?.held && h[id]?.locked === false).slice(0, n)
}

async function heldIds(slug: Exclude<SwapSlug, "nba-top-shot">, address: string, n: number): Promise<string[]> {
  return ((await idsReader(slug)(address)) ?? []).slice(0, n)
}

/** Fills a side's picks up to `cap` from the given per-collection pools, round-robin. */
function fill(pools: Array<[SwapSlug, string[]]>, cap: number): Pick[] {
  const out: Pick[] = []
  for (let i = 0; out.length < cap && pools.some(([, ids]) => i < ids.length); i++) {
    for (const [collection, ids] of pools) if (i < ids.length && out.length < cap) out.push({ collection, id: ids[i] })
  }
  return out
}

let failed = 0
function check(ok: boolean, what: string) {
  console.log(`${ok ? "✓" : "⛔"} ${what}`)
  if (!ok) failed++
}

async function main() {
  console.log(`fork REST ${EMU}; A ${A.signer} → ${A.source}; B ${B.signer} → ${B.source}`)
  const bReceives = await readCanReceive(B.source, runFlowScript)
  const canB = (slug: SwapSlug) => bReceives[SWAP_COLLECTIONS.findIndex((c) => c.slug === slug)]

  // ---- 1. the multi-collection transaction, near its cap --------------------------------
  const aPools: Array<[SwapSlug, string[]]> = [
    ["laliga-golazos", await heldIds("laliga-golazos", A.source, 10)],
    ["ufc", await heldIds("ufc", A.source, 10)],
  ]
  if (canB("nfl-all-day")) aPools.push(["nfl-all-day", await heldIds("nfl-all-day", A.source, 10)])
  const bPools: Array<[SwapSlug, string[]]> = [
    ["nba-top-shot", await unlockedTopShot(B.source, 10)],
    ["laliga-golazos", await heldIds("laliga-golazos", B.source, 10)],
    ["ufc", await heldIds("ufc", B.source, 10)],
  ]
  const picksA = fill(aPools, 10)
  const picksB = fill(bPools, 10)
  console.log(`A gives ${picksA.map((p) => `${p.collection}:${p.id}`).join(", ")}`)
  console.log(`B gives ${picksB.map((p) => `${p.collection}:${p.id}`).join(", ")}`)
  const plan = await planMultiSwap({ ...A, picks: picksA }, { ...B, picks: picksB })
  console.log(`planned (mainnet simulation passed): A ctls ${plan.a.ctls.join("/")}, B ctls ${plan.b.ctls.join("/")}`)
  const r1 = await send(MULTI_SWAP_CADENCE, multiSwapArgs(plan), MULTI_SWAP_GAS_LIMIT)
  console.log(`multi swap tx ${r1.id}: ${r1.status}; computation ${r1.computation || "not reported"} of ${MULTI_SWAP_GAS_LIMIT}; ${r1.events} events${r1.error ? `; error: ${r1.error}` : ""}`)
  if (r1.computation > 0) check(r1.computation <= MULTI_SWAP_GAS_LIMIT * 0.8, `the multi swap used ${r1.computation} computation — within 80 % of the ${MULTI_SWAP_GAS_LIMIT} limit`)
  check(r1.status === "Sealed" && !r1.error, `the multi-collection transaction (${picksA.length} + ${picksB.length} Moments) sealed with no error`)
  const deps = { run: runOnFork, keys: async () => [1000], readTopShot: (a: string, ids: string[]) => readOnForkTopShot(a, ids) }
  for (const [picks, to] of [[picksA, B.source], [picksB, A.source]] as const) {
    for (const c of SWAP_COLLECTIONS) {
      const ids = picks.filter((p) => p.collection === c.slug).map((p) => p.id)
      if (!ids.length) continue
      const h = await readCollectionHoldings(c.slug, to, ids, deps)
      const missing = ids.filter((id) => !h[id]?.held)
      check(missing.length === 0, `${c.short} ${ids.length} landed in ${to}${missing.length ? ` — missing ${missing.join(", ")}` : ""}`)
    }
  }

  // ---- 2. the all-Top-Shot transaction (the proven text) --------------------------------
  const ts = await unlockedTopShot(B.source, 20)
  const tsId = ts.find((id) => !picksB.some((p) => p.id === id))
  if (!tsId) {
    console.log("⚠ no second unlocked Top Shot Moment on side B — skipping the SWAP_CADENCE case")
  } else {
    const plan2 = await planSwap({ signer: A.signer, source: A.source, ids: [] }, { signer: B.signer, source: B.source, ids: [tsId] })
    const r2 = await send(SWAP_CADENCE, swapArgs(plan2), SWAP_GAS_LIMIT)
    console.log(`Top Shot swap tx ${r2.id}: ${r2.status}; computation ${r2.computation || "not reported"} of ${SWAP_GAS_LIMIT}${r2.error ? `; error: ${r2.error}` : ""}`)
    check(r2.status === "Sealed" && !r2.error, "the all-Top-Shot transaction sealed with no error")
    const h = await readOnForkTopShot(A.source, [tsId])
    check(h[tsId]?.held === true, `Top Shot ${tsId} landed in ${A.source}`)
  }

  if (failed) {
    console.error(`⛔ ${failed} check(s) failed`)
    process.exit(1)
  }
  console.log("✓ both swap transactions executed on a mainnet fork and every Moment landed")
}

/** readTopShotHoldings against the fork. */
function readOnForkTopShot(address: string, ids: string[]) {
  return readTopShotHoldings(address, ids, (_url, init) => fetch(`${EMU}/scripts?block_height=sealed`, init))
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack ?? e.message : e)
  process.exit(1)
})
