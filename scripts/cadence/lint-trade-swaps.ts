#!/usr/bin/env node
// scripts/cadence/lint-trade-swaps.ts
//
// TYPE-CHECKS the trade swap transactions against the contracts DEPLOYED on mainnet
// (2026-11-02, Trevor: "Dig deeper"). The trade room's swaps were proven by SIMULATION
// (a script built from the same fragments, run against live state) — that runs the legs but
// is not the transaction: a field, an entitlement on `prepare`'s account, or an
// execute-phase reference could be wrong in the transaction text alone. This checks the
// exact text the wallets sign, with the Cadence checker of the Flow CLI, against every
// contract it imports and everything THEY import, fetched from mainnet now.
//
//   npm run cadence:lint-swaps
//
// What it does:
//   1. fetches each imported contract's deployed source (Flow REST `?expand=contracts`),
//      transitively, and rewrites address imports to string imports so the checker resolves
//      them from local files (it cannot reach mainnet gRPC from a sandbox);
//   2. writes SWAP_CADENCE (Top Shot, sealed twice 10-31), MULTI_SWAP_CADENCE and its
//      simulation script, and runs `flow cadence lint` on them;
//   3. ⚠ PROVES IT CAN FAIL: lints three planted defects (a missing function, a wrong NFT
//      type, a missing HybridCustody entitlement) and exits non-zero unless each is an error.
// Exits 0 only when the real texts have 0 errors AND every planted defect was caught.
//
// Needs the Flow CLI: `FLOW_CLI=/path/to/flow` or `flow` on PATH (download a release from
// github.com/onflow/flow-cli — v2.19.0 checked it 2026-11-02; v2.12.0's checker is older than
// mainnet's TopShot and reports a false error inside the deployed contract itself).
// Network: rest-mainnet.onflow.org only. Writes to a temp dir; touches nothing in the repo.

import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SWAP_CADENCE } from "../../lib/swap-test/swap-cadence"
import { MULTI_SWAP_CADENCE, MULTI_SWAP_SIMULATION_SCRIPT } from "../../lib/trade-room/multi-swap-cadence"

const IMPORT = /import\s+([A-Za-z_][A-Za-z0-9_]*)\s+from\s+0x([0-9a-fA-F]{1,16})/g
const pad = (a: string) => a.toLowerCase().padStart(16, "0")
const toStringImports = (s: string) => s.replace(IMPORT, (_m, n) => `import "${n}"`)

const accounts = new Map<string, Record<string, string>>()
async function sourcesAt(addr: string): Promise<Record<string, string>> {
  const hit = accounts.get(addr)
  if (hit) return hit
  const res = await fetch(`https://rest-mainnet.onflow.org/v1/accounts/0x${addr}?expand=contracts`, { signal: AbortSignal.timeout(30_000) })
  if (!res.ok) throw new Error(`Flow REST account 0x${addr}: HTTP ${res.status}`)
  const body = (await res.json()) as { contracts?: Record<string, string> }
  const out = Object.fromEntries(Object.entries(body.contracts ?? {}).map(([k, v]) => [k, Buffer.from(v, "base64").toString("utf8")]))
  accounts.set(addr, out)
  return out
}

const contracts = new Map<string, { addr: string; src: string }>()
async function want(name: string, addr: string): Promise<void> {
  const seen = contracts.get(name)
  if (seen) {
    if (seen.addr !== addr) throw new Error(`two contracts named ${name} (0x${seen.addr}, 0x${addr}) — string imports cannot tell them apart`)
    return
  }
  const src = (await sourcesAt(addr))[name]
  if (!src) throw new Error(`0x${addr} deploys no contract named ${name}`)
  contracts.set(name, { addr, src })
  for (const m of src.matchAll(IMPORT)) await want(m[1], pad(m[2]))
}

function lint(cli: string, dir: string, files: string[]): { errors: number; output: string } {
  let output: string
  try {
    output = execFileSync(cli, ["cadence", "lint", ...files, "-f", "flow.json"], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
  } catch (e) {
    const x = e as { stdout?: string; stderr?: string }
    output = `${x.stdout ?? ""}${x.stderr ?? ""}`
  }
  const m = output.match(/(\d+) problems? \((\d+) errors?/)
  if (!m) {
    // a lint that prints no summary has not spoken — never read silence as zero errors
    throw new Error(`flow cadence lint printed no summary:\n${output.slice(-2000)}`)
  }
  return { errors: Number(m[2]), output }
}

async function main() {
  const cli = process.env.FLOW_CLI || "flow"
  const texts: Record<string, string> = {
    "swap_topshot.cdc": SWAP_CADENCE,
    "swap_multi.cdc": MULTI_SWAP_CADENCE,
    "sim_multi.cdc": MULTI_SWAP_SIMULATION_SCRIPT,
  }
  for (const code of Object.values(texts)) for (const m of code.matchAll(IMPORT)) await want(m[1], pad(m[2]))

  const dir = mkdtempSync(join(tmpdir(), "rpc-swap-lint-"))
  mkdirSync(join(dir, "contracts"))
  const flow: { networks: Record<string, string>; accounts: object; deployments: object; contracts: Record<string, unknown> } = {
    networks: { emulator: "127.0.0.1:3569", mainnet: "access.mainnet.nodes.onflow.org:9000" },
    accounts: {},
    deployments: {},
    contracts: {},
  }
  for (const [name, { addr, src }] of contracts) {
    writeFileSync(join(dir, "contracts", `${name}.cdc`), toStringImports(src))
    flow.contracts[name] = { source: `./contracts/${name}.cdc`, aliases: { mainnet: addr } }
  }
  writeFileSync(join(dir, "flow.json"), JSON.stringify(flow, null, 2))
  for (const [f, code] of Object.entries(texts)) writeFileSync(join(dir, f), toStringImports(code))
  console.log(`fetched ${contracts.size} deployed contracts: ${[...contracts].map(([n, c]) => `${n}@0x${c.addr}`).join(" ")}`)

  const real = lint(cli, dir, Object.keys(texts))
  console.log(`real texts: ${real.errors} error(s)`)

  const multi = toStringImports(MULTI_SWAP_CADENCE)
  const planted: Array<[string, string, string]> = [
    ["a missing function", "withdraw(withdrawID: id)", "withdrawz(withdrawID: id)"],
    ["a wrong NFT type", "Type<@UFC_NFT.NFT>()", "Type<@UFC_NFT.Moment>()"],
    ["a missing HybridCustody entitlement", "auth(HybridCustody.Manage) &HybridCustody.Manager", "&HybridCustody.Manager"],
  ]
  let missed = 0
  for (const [label, from, to] of planted) {
    if (!multi.includes(from)) throw new Error(`planted defect "${label}": the text no longer contains ${from} — update this script`)
    writeFileSync(join(dir, "planted.cdc"), multi.split(from).join(to))
    const r = lint(cli, dir, ["planted.cdc"])
    console.log(`planted ${label}: ${r.errors} error(s)${r.errors === 0 ? "  ⛔ NOT CAUGHT" : ""}`)
    if (r.errors === 0) missed++
  }

  if (real.errors > 0) {
    console.error(real.output)
    console.error(`⛔ ${real.errors} error(s) in the swap texts — do not ship them`)
    process.exit(1)
  }
  if (missed > 0) {
    console.error(`⛔ ${missed} planted defect(s) were NOT caught — this check cannot be trusted as configured`)
    process.exit(2)
  }
  console.log("✓ the swap transactions type-check against the deployed contracts, and the checker catches every planted defect")
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e)
  process.exit(1)
})
