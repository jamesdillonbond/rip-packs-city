#!/usr/bin/env node
// Type-check every inline Cadence SCRIPT in the repo against mainnet's deployed contracts.
//
// WHY (2026-11-15): a script that does not type-check fails on EVERY call, and every caller
// here catches the error per moment / per edition, so the lane reports success while doing
// nothing. Measured that day: 10 of 108 inline scripts had never type-checked, including
// /api/cache-refresh's Top Shot metadata script (`data.momentTierString`, a member the view
// does not have: no Top Shot stub was ever enriched there), its All Day scripts (a public
// path nothing publishes; `borrowMomentNFT` on an interface that is empty in Cadence 1.0),
// and the All Day edition-data script behind three lanes (`??` on non-optional values).
// Nothing caught any of it: vitest mocks fcl, and test:cadence only lints the trade-room
// transactions (.github/workflows/cadence-swap-lint.yml).
//
// HOW: every template literal containing `fun main(` in app/, lib/, supabase/functions/,
// scripts/ and workers/ is POSTed to the Flow REST script endpoint with placeholder
// arguments chosen by parameter type. A placeholder makes most scripts PANIC at runtime
// (wrong address, unknown id) — that is fine and counted as "ran". What fails the check is
// a TYPE error: the script could never run with any arguments.
//   - Literals with `${…}` interpolation and parameter types we cannot fake are SKIPPED
//     and listed, never silently passed.
//   - A planted broken script must be classified CHECK-FAIL, or the run fails (a checker
//     that cannot see the defect class must not report green).
//   - Fewer than MIN_EXECUTED scripts executed fails the run (a walk that inspected nothing
//     has not passed — it has not spoken).
//   - HTTP errors other than the script's own 400 (429, 5xx, network) are INCONCLUSIVE;
//     more than 10 % inconclusive fails the run rather than reading as clean.
//
// Usage: node scripts/cadence/check-inline-scripts.mjs   (exit 0 clean, 1 defect / unreliable)
import fs from "node:fs"
import path from "node:path"

const ENDPOINT = "https://rest-mainnet.onflow.org/v1/scripts?block_height=sealed"
const MIN_EXECUTED = 80

// ⛔ A SUPPRESSION IS A CLAIM THAT THE CODE IS DEAD, not that the script is fine. Each entry
// names why nothing live runs it. Key: repo-relative path with forward slashes + ":" + the
// literal's first line number. Remove the entry when the code is deleted or fixed.
const KNOWN_DEAD = {
  "lib/chains/flow/allday-cadence.ts:5":
    "GET_EDITIONS_IN_SET — used only by /api/allday-sets, which has no caller (no fetch, cron, workflow; superseded by /api/allday-set-progress). SetData has no editionIDs.",
  "lib/chains/flow/allday-cadence.ts:15": "GET_EDITION_DATA — /api/allday-sets only (see above).",
  "lib/chains/flow/allday-cadence.ts:31": "GET_PLAY_DATA — /api/allday-sets only (see above).",
  "lib/chains/flow/allday-cadence.ts:120": "GET_MOMENT_METADATA — /api/allday-sets only (see above).",
  "lib/chains/flow/cadence/pinnacle-wallet.ts:57": "GET_PINNACLE_METADATA — exported, imported by nothing.",
  // scan-ufc-wallet's metadata script was fixed 2026-11-16 (UFC_NFT.Collection + borrowUFC_NFT) — no longer suppressed.
}

const PLANTED = {
  f: "<planted>",
  line: 0,
  code: `import AllDay from 0xe4cf4bdc1751c65d
access(all) fun main(editionID: UInt64): String {
  let ed = AllDay.getEditionData(id: editionID)
  return ed.tier ?? "COMMON"
}`,
  args: [{ type: "UInt64", value: "1" }],
}

// A message that means the script RAN (and failed on our fake arguments), not that it is ill-typed.
const RUNTIME = /panic|unexpectedly found nil|pre-condition|precondition|post-condition|computation limit|out of bounds|overflow|underflow|failed to borrow|could not borrow|division by zero|force-unwrap|storage|no collection|no nft|not found|no such/i

const roots = ["app", "lib", "supabase/functions", "scripts", "workers"].filter((r) => fs.existsSync(r))
const files = []
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue
    const p = path.join(d, e.name)
    if (e.isDirectory()) walk(p)
    else if (/\.(ts|tsx|mjs|js)$/.test(e.name) && !/\.test\./.test(e.name)) files.push(p)
  }
}
roots.forEach(walk)

const dummy = (t) => {
  t = t.trim()
  if (t.endsWith("?")) return { type: "Optional", value: null }
  if (t.startsWith("[")) return { type: "Array", value: [] }
  if (t.startsWith("{")) return { type: "Dictionary", value: [] }
  if (t === "Address") return { type: "Address", value: "0x0b2a3299cc857e29" }
  if (t === "String") return { type: "String", value: "" }
  if (t === "Bool") return { type: "Bool", value: false }
  if (/^U?Int\d*$|^Word\d+$/.test(t)) return { type: t, value: "1" }
  if (/^U?Fix64$/.test(t)) return { type: t, value: "1.0" }
  return null
}

const items = []
const skipped = []
for (const f of files) {
  const rel = f.split(path.sep).join("/")
  if (rel === "scripts/cadence/check-inline-scripts.mjs") continue
  const src = fs.readFileSync(f, "utf8")
  const re = /`([^`]*?fun\s+main\s*\(([^)]*)\)[^`]*)`/g
  let m
  while ((m = re.exec(src))) {
    const line = src.slice(0, m.index).split("\n").length
    const code = m[1]
    if (code.includes("${")) { skipped.push(`${rel}:${line} (interpolated)`); continue }
    const params = m[2].split(",").map((s) => s.trim()).filter(Boolean).map((s) => s.split(":").slice(1).join(":"))
    const args = params.map(dummy)
    if (args.some((a) => a === null)) { skipped.push(`${rel}:${line} (argument types ${params.join(", ")})`); continue }
    items.push({ f: rel, line, code, args })
  }
}

async function run(item) {
  for (let attempt = 0; attempt < 3; attempt++) {
    let status = 0
    let txt = ""
    try {
      const r = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          script: Buffer.from(item.code).toString("base64"),
          arguments: item.args.map((a) => Buffer.from(JSON.stringify(a)).toString("base64")),
        }),
      })
      status = r.status
      txt = await r.text()
    } catch (e) {
      txt = String(e?.message ?? e)
    }
    if (status === 200) return { kind: "ran" }
    if (status === 400) {
      const msgs = [...txt.matchAll(/error: (.*?)(\\n|$)/g)]
        .map((x) => x[1])
        .filter((s) => !/caused by|failed to execute|Execution failed|occurred/.test(s))
      const first = msgs[0] || txt.slice(0, 200)
      return RUNTIME.test(first) ? { kind: "ran" } : { kind: "check", msg: first.slice(0, 200) }
    }
    await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)))
  }
  return { kind: "inconclusive" }
}

const planted = await run(PLANTED)
if (planted.kind !== "check") {
  console.error(`✗ planted defect NOT caught (classified ${planted.kind}) — the checker cannot see the class it exists for.`)
  process.exit(1)
}

const failures = []
const suppressed = []
let inconclusive = 0
for (const item of items) {
  const res = await run(item)
  if (res.kind === "inconclusive") inconclusive++
  if (res.kind === "check") {
    const key = `${item.f}:${item.line}`
    if (KNOWN_DEAD[key]) suppressed.push(`${key}  (${KNOWN_DEAD[key].slice(0, 90)})`)
    else failures.push(`${key}  ${res.msg}`)
  }
  await new Promise((r) => setTimeout(r, 100))
}

const unusedSuppressions = Object.keys(KNOWN_DEAD).filter((k) => !suppressed.some((s) => s.startsWith(k + " ")))

console.log(`inline Cadence scripts: ${items.length} executed, ${skipped.length} skipped, ${inconclusive} inconclusive`)
console.log(`planted defect: caught`)
for (const s of skipped) console.log(`  skipped ${s}`)
for (const s of suppressed) console.log(`  known-dead ${s}`)
for (const s of unusedSuppressions) console.log(`  ⚠ suppression no longer needed (fixed or moved): ${s}`)

let bad = false
if (items.length < MIN_EXECUTED) {
  console.error(`✗ only ${items.length} scripts executed (< ${MIN_EXECUTED}); the walk may have inspected nothing.`)
  bad = true
}
if (inconclusive > items.length * 0.1) {
  console.error(`✗ ${inconclusive} of ${items.length} inconclusive (network / rate limit); not a clean result.`)
  bad = true
}
if (failures.length) {
  console.error(`\n✗ ${failures.length} inline Cadence script(s) do not type-check against mainnet — every call to them fails:`)
  for (const f of failures) console.error("  " + f)
  bad = true
}
if (bad) process.exit(1)
console.log(`\n✓ every executed inline Cadence script type-checks against mainnet`)
