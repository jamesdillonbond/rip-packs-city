#!/usr/bin/env node
//
// scripts/check-unbounded-server-reads.mjs
//
// ── WHAT THIS COUNTS ────────────────────────────────────────────────────────
// Async server `page.tsx` / `layout.tsx` under `app/**` that can reach a
// Supabase read without passing through a budget primitive.
//
// ── WHY A RATCHET AND NOT A BAN ─────────────────────────────────────────────
// `__tests__/insights-server-pages-bound-their-reads.test.ts` is a BAN, and it
// works because that population was driven to zero in the same pass. This one
// cannot be: the population outside `/insights` is 18 non-admin surfaces, several
// on the roadmap's untouchable list (pack-EV, sniper, FMV route logic), and
// several with NO honest-degraded branch to reject INTO — bounding those blind
// would turn a slow page into a thrown error boundary, which is worse than slow.
// A ban here would ship an 18-entry allowlist, and "a curated list drifts" is
// already recorded twice in this repo. A ratchet needs no allowlist: the number
// may only fall.
//
// ── WHY THE CLASS IS WORTH A GUARD AT ALL ───────────────────────────────────
// Fourth occurrence, same error string every time — "Timed out acquiring
// connection from connection pool":
//   1. first-mint            -> BOARD_LIVE_TIMEOUT_MS
//   2. /analytics/sets       -> SET_DETAIL_TIMEOUT_MS
//   3. /insights/market(+pulse) -> two ERRORed production builds, 2026-08-15
//   4. /[collection]/overview   -> four collections' pages hung 30s, 2026-08-22
// Each of the first three was fixed on the ONE page that failed. The guard
// written to make it shape-level walks `app/insights`, so occurrence 4 was
// outside it BY CONSTRUCTION. This file is the population that guard cannot see.
//
// ⚠ WHAT IT IS STRUCTURALLY SILENT ABOUT — read before trusting a number:
//   * Import following stops at depth 3 and only follows `@/lib/**` and
//     `@/components/**`. A deeper chain, a dynamic import or a re-export barrel
//     is invisible.
//   * It cannot tell a read that BLOCKS the stream from one inside `<Suspense>`.
//     Suspense is a legitimate answer to this class and would still count here.
//   * A page may be fine for a reason this cannot see. A hit is a thing to LOOK
//     AT; the ratchet's job is to stop the number growing, not to indict a file.
//
// ⚠ `Array.from(` matched an earlier, looser query pattern and put `app/page.tsx`
// and `app/(collections)/layout.tsx` on the list via a client hook with no DB in
// it — it inflated the count from 19 to 31. supabase-js takes a STRING first
// argument on both `.from()` and `.rpc()`, so the pattern requires one.

import { readdirSync, readFileSync, statSync, existsSync } from "node:fs"
import { join } from "node:path"

// ⚠ RATCHET BASELINE. This may only ever go DOWN. Lower it in the same commit
// that bounds a page — never raise it to make a build pass.
const MAX_UNBOUNDED = 17

const strip = (s) =>
  s
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ""))
    .replace(/(^|[^:])\/\/.*$/gm, (_m, p1) => p1)

const USE_CLIENT = /^\s*["']use client["']/
const DIRECT_QUERY = /(?<![A-Za-z])(?<!Array)\.from\s*\(\s*["'`]|\.rpc\s*(?:as any\))?\s*\(\s*["'`]/
const BOUNDED = [
  /readBoardOrLive\s*(?:<[^>]*>)?\s*\(/,
  /fetchBoardForPage\s*(?:<[^>]*>)?\s*\(/,
  /withBoardBudget\s*(?:<[^>]*>)?\s*\(/,
  /withPagedBoardBudget\s*(?:<[^>]*>)?\s*\(/,
]
const MAX_DEPTH = 3

const entries = []
function walk(dir) {
  let names
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p)
    else if (name === "page.tsx" || name === "layout.tsx") entries.push(p)
  }
}
walk("app")

function resolveModule(spec) {
  for (const ext of [".ts", ".tsx", "/index.ts", "/index.tsx"]) {
    if (existsSync(spec + ext)) return spec + ext
  }
  return null
}

function importsOf(src) {
  const out = []
  for (const m of src.matchAll(/from\s+["']@\/((?:lib|components)\/[A-Za-z0-9._$/-]+)["']/g)) {
    const f = resolveModule(m[1])
    if (f) out.push(f)
  }
  return out
}

/** Walk the module graph from a server entry. A budget primitive anywhere on the
 *  path counts as bounded — the same one-level-of-delegation reasoning the
 *  /insights ban uses, widened to the depth this tree actually has. */
function analyze(file) {
  const seen = new Set()
  let readAt = null
  const stack = [[file, 0]]
  while (stack.length) {
    const [f, depth] = stack.pop()
    if (seen.has(f) || depth > MAX_DEPTH) continue
    seen.add(f)
    let src
    try {
      src = strip(readFileSync(f, "utf8"))
    } catch {
      continue
    }
    if (BOUNDED.some((re) => re.test(src))) return { bounded: true, readAt: null }
    if (DIRECT_QUERY.test(src) && !readAt) readAt = f
    for (const dep of importsOf(src)) stack.push([dep, depth + 1])
  }
  return { bounded: false, readAt }
}

let asyncServer = 0
const unbounded = []
for (const file of entries) {
  const raw = readFileSync(file, "utf8")
  if (USE_CLIENT.test(raw.split("\n").slice(0, 3).join("\n"))) continue
  if (!/export default async function/.test(raw)) continue
  asyncServer++
  const { bounded, readAt } = analyze(file)
  if (bounded || !readAt) continue
  unbounded.push({ file, readAt })
}

console.log(
  `[unbounded-server-reads] ${entries.length} page/layout file(s); ` +
    `${asyncServer} async server; ${unbounded.length} unbounded (ceiling ${MAX_UNBOUNDED})`,
)

// Positive control on the guard's own reach. A zero here means the walk stopped
// seeing the app tree, not that the tree is clean — the failure mode this repo
// keeps recording as indistinguishable from success at a glance.
if (entries.length === 0 || asyncServer === 0) {
  console.error(
    "[unbounded-server-reads] INSTRUMENT BROKEN: walked " +
      `${entries.length} page/layout file(s) and found ${asyncServer} async server one(s). ` +
      "It cannot see what it is meant to check, so a pass means nothing.",
  )
  process.exit(1)
}

for (const u of unbounded) console.log(`    ${u.file}\n        read reachable at: ${u.readAt}`)

if (unbounded.length > MAX_UNBOUNDED) {
  console.error(
    `\n[unbounded-server-reads] RATCHET BROKEN: ${unbounded.length} > ${MAX_UNBOUNDED}.\n` +
      "A new async server page/layout can reach a Supabase read with no budget. Route it through\n" +
      "withBoardBudget (or fetchBoardForPage / readBoardOrLive) so a SLOW read reaches the page's\n" +
      "degraded branch — a query that merely hangs errors nowhere, and on a prerendered page it can\n" +
      "take the whole build down. If the page has no degraded branch yet, give it one first:\n" +
      "bounding without one turns a slow page into a thrown error boundary, which is worse.\n" +
      "Do NOT raise MAX_UNBOUNDED to get past this.",
  )
  process.exit(1)
}

if (unbounded.length < MAX_UNBOUNDED) {
  console.log(
    `\n[unbounded-server-reads] Ratchet can tighten: lower MAX_UNBOUNDED to ${unbounded.length} in this commit.`,
  )
}
console.log("[unbounded-server-reads] ok")
