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
import { pathToFileURL } from "node:url"
import { stripComments } from "./lib/strip-comments.mjs"

// ⚠ RATCHET BASELINE. This may only ever go DOWN. Lower it in the same commit
// that bounds a page — never raise it to make a build pass.
//
// 17 (2026-08-22) → 15 (2026-08-22, same day): `lib/wallet/pinned-wallet.ts`
// bounded (clears `/fast-break`, `/road-to-the-ring`) and `lib/flowty-username.ts`
// bounded (clears `/moment/[id]`, `/analytics/wallets/[address]`).
//
// ⚠ CONTROL RUN, because `analyze()` changed in the same commit and a number
// measured by two different instruments is two numbers. The corrected analysis
// was run against the tree with BOTH lib fixes reverted and also reported 17 —
// the two agree at the baseline, because before this commit no shared lib on
// those paths carried a budget primitive for the old rule to over-clear on.
// With the fixes applied it reports 15. So the drop is 2 real pages, not an
// artifact. ⚠ The intermediate reading of 11, seen with the OLD analyze and the
// new lib bounds, was the artifact — see the note on `analyze()`.
//
// 15 → 13 (2026-08-22): `lib/profile/public-profile.ts` bounded, clearing
// `/profile/[username]` and `/profile/[username]/trophy-case`. ⚠ Safe there ONLY
// because `ProfileClient` re-fetches every field on mount, so the SSR payload is
// a first-paint optimisation rather than the page's sole source — and the module
// already separated 500 (the DB answered with an error) from 404 (no such
// username). The overrun answers a THIRD status, 503; see the module for why it
// must never be 404 on a page collectors share.
//
// 13 → 12 (2026-08-22): `lib/fan-teams/fetchers.ts` bounded, clearing
// `/my-teams`. ⚠ All three of its functions already distinguished a failed read
// from an empty one and the page already rendered that distinction — the
// honesty work was done and was UNREACHABLE from a hang, which is worth noting
// because "the page has an ok:false branch" reads like coverage and, for a slow
// read, was not.
//
// 12 → 10 (2026-08-22): `lib/fast-break/page-data.ts` and
// `lib/moment-detail/fetchers.ts` bounded, clearing `/[collection]/fast-break`
// and `/moment/[id]`. ⚠ Both pages were on this list a SECOND time — the
// path-sensitivity fix above made their OTHER reads visible once the first lib
// each page reached had been bounded. That is the guard working: a page leaves
// only when every read it can reach is accounted for.
//
// 10 → 8 (2026-08-22), and the two halves were measured SEPARATELY because the
// instrument changed in the same commit:
//   * `withQueryDeadline` added to BOUNDED above → 10 → 9. That is a FALSE
//     POSITIVE removed, not a page fixed: `/[collection]/edition/[slug]` performs
//     no read of its own and both of `lib/edition/fetchers.ts`'s reads already
//     went through it. Verified read-by-read, with the pack-dist bounds reverted,
//     before the ceiling moved.
//   * `lib/pack-dist/fetchers.ts` bounded (13 reads) → 9 → 8. A real fix, on the
//     page carrying production's top user-impacting errors.
//
// 8 → 6 (2026-08-22): `lib/set-detail/tier-mix.ts` and
// `lib/pinnacle/moment-detail.ts` bounded, clearing `/[collection]/set/[slug]`
// and `/pinnacle/moment/[id]`. ⚠ Both needed a SHARED deadline rather than a
// per-read one — tier-mix pages up to 60 times, and pinnacle's `load()` is a
// chain of up to six sequential steps. A per-read budget on either would have
// multiplied the worst case it was added to cap. Both are mutation-proven
// against that specific mistake, not just against "no bound at all".
//
// 6 → 4 (2026-08-22): `/[collection]/hot-floors` and `/[collection]/challenges`
// had their single read EXTRACTED into `lib/hot-floors/fetchers.ts` and
// `lib/challenges/hub-fetchers.ts`, then bounded and tested. ⚠ Both pages already
// wrapped the read in `try/catch` and already had the right honest branch — and
// neither was reachable, because **a try/catch catches a THROW and a hang throws
// nothing**. That is the sharpest statement of this whole class: the error
// handling looked complete and could not fire.
//
// 4 → 3 (2026-08-22): `/analytics/wallets` — same extract-then-bound as the two
// above, and the same already-existing-but-unreachable honest branch (a bare
// `[]` used to render "No wallet activity to display.", a claim about the loan
// book made from a database error).
//
// 3 → 1 (2026-08-22): `/admin/flowty-errors` and `/[collection]/pack/[id]`
// extracted and bounded. ⚠ The ONE that remains is `lib/packs/pack-deals.ts`
// behind `/[collection]/pack-sniper`, which the roadmap lists as untouchable —
// so 1 is the FLOOR under the current rules, not a residue nobody got to. Stated
// here because a ratchet at 1 with no explanation invites someone to "finish the
// job" on a surface that is deliberately off-limits.
const MAX_UNBOUNDED = 1

const strip = (s) => stripComments(s)

const USE_CLIENT = /^\s*["']use client["']/
// ⚠ `(?<!\bArray)` and NOT `(?<![A-Za-z])(?<!Array)`. The original pair was
// meant to exclude `Array.from(`, but the first lookbehind excludes ANY letter
// before the dot — which is every `supabaseAdmin.from("x")` written on ONE LINE.
// The guard only ever matched real queries because most chains put `.from(` on
// its own line after a newline. Measured 2026-08-22: 12 files under `app/` and
// `lib/` carry a `.from("…")` the old pattern could not see. Correcting it does
// not move the page-level count (15 either way — none of the 12 changes a
// verdict), which is why it ships as a pure sensitivity fix rather than with a
// ratchet bump: the blind spot is closed BEFORE it hides something.
const DIRECT_QUERY = /(?<!\bArray)\.from\s*\(\s*["'`]|\.rpc\s*(?:as any\))?\s*\(\s*["'`]/
const BOUNDED = [
  /readBoardOrLive\s*(?:<[^>]*>)?\s*\(/,
  /fetchBoardForPage\s*(?:<[^>]*>)?\s*\(/,
  /withBoardBudget\s*(?:<[^>]*>)?\s*\(/,
  /withPagedBoardBudget\s*(?:<[^>]*>)?\s*\(/,
  // ⚠ A FOURTH primitive, added 2026-08-22, and the list is a CURATED LIST —
  // the shape this repo has twice recorded as drifting. `withQueryDeadline`
  // (lib/analytics/rpc-with-retry.ts) is a genuine wall-clock bound and had
  // been invisible here, so `/[collection]/edition/[slug]` sat on this report
  // while BOTH of its reads went through it and the page itself performs none.
  // Verified read-by-read before adding, not inferred from the import.
  //
  // 🚨 `rpcWithRetry` IS DELIBERATELY *NOT* HERE, and the reason is measured.
  // `lib/pack-dist/fetchers.ts` routed ONE read through it and left THIRTEEN
  // bare — so recognising it would have cleared `/[collection]/pack/dist/[distId]`
  // on the strength of a single bounded read, while the page's own top
  // production errors (pack_realized_ev at 124 users, pack_lifecycle at 86)
  // came from the thirteen. That is the module-level blind spot this file's
  // `analyze()` note describes, one level down: a budget primitive vouches for
  // every read in its module, whether or not it wraps them. ⚠ Before adding a
  // fifth entry, check that every read in the modules it would clear actually
  // passes through it.
  /withQueryDeadline\s*(?:<[^>]*>)?\s*\(/,
]
const MAX_DEPTH = 3

function walk(dir, entries) {
  let names
  try {
    names = readdirSync(dir)
  } catch {
    return
  }
  for (const name of names) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, entries)
    else if (name === "page.tsx" || name === "layout.tsx") entries.push(p)
  }
}

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

/**
 * Walk the module graph from a server entry. A budget primitive counts for the
 * module that carries it AND everything it reaches — the one-level-of-delegation
 * reasoning the /insights ban uses (a page calling `fetchBoardForPage(fetcher)`
 * is bounded even though the raw query lives in the fetcher), widened to the
 * depth this tree actually has.
 *
 * ⚠ FIXED 2026-08-22 — IT USED TO RETURN THE MOMENT IT SAW A BUDGET PRIMITIVE
 * ANYWHERE IN THE GRAPH, which cleared the whole page. That made the instrument
 * LESS sensitive as the tree got partially fixed: bounding one shared lib
 * silently cleared every page that imports it, including pages whose OWN reads
 * were still unbounded. Measured when it happened — bounding
 * `lib/flowty-username.ts` dropped SIX pages off the report, but only four of
 * them had actually been fixed; `analytics/wallets/page.tsx` and
 * `[collection]/pack/dist/[distId]` were cleared purely by importing it.
 *
 * ⚠ The distinction is PER PATH, not per graph: `boundedOnPath` is inherited by
 * a module's own imports and by nothing else, so a sibling's budget can no
 * longer vouch for a read it does not wrap. `seen` is keyed on the pair, because
 * a module first reached down a BOUNDED path must still be examined when it is
 * also reachable down an unbounded one — keying on the filename alone made the
 * verdict depend on DFS pop order.
 */
export function analyze(file) {
  const seen = new Set()
  let readAt = null
  const stack = [[file, 0, false]]
  while (stack.length) {
    const [f, depth, boundedOnPath] = stack.pop()
    const key = `${f}|${boundedOnPath}`
    if (seen.has(key) || depth > MAX_DEPTH) continue
    seen.add(key)
    let src
    try {
      src = strip(readFileSync(f, "utf8"))
    } catch {
      continue
    }
    const bounded = boundedOnPath || BOUNDED.some((re) => re.test(src))
    if (!bounded && DIRECT_QUERY.test(src) && !readAt) readAt = f
    for (const dep of importsOf(src)) stack.push([dep, depth + 1, bounded])
  }
  return { bounded: readAt === null, readAt }
}

// ── CLI ─────────────────────────────────────────────────────────────────────
// Everything above is importable so `__tests__/unbounded-server-reads-analyze.test.ts`
// can exercise `analyze()` directly. Everything below runs only as the entry
// point — an unguarded top-level `walk("app")` would make importing the module
// scan the whole tree, which is exactly how a test ends up asserting against
// production instead of its fixtures.
function main() {
const entries = []
walk("app", entries)
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
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) main()
