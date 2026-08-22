import { describe, it, expect } from "vitest"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { isClientSource } from "./helpers/client-directive"
import { join, relative, sep } from "node:path"
import { stripComments } from "../scripts/lib/strip-comments.mjs"

// RATCHET on the single idiom behind every account-level honesty defect found
// on 2026-08-16: a client-side read that funnels a FAILURE into the same value
// a successful-but-empty read produces.
//
//     .then((r) => (r.ok ? r.json() : null))   // then `?? []` downstream
//     await res.json().catch(() => null)
//     if (!res.ok) { setRows([]); return }
//
// Each is fine in isolation. Each becomes a defect the moment the empty value
// renders as a CLAIM — and on a signed-in surface the claim is about the
// reader's own account, which is the worst version: they are the one person who
// knows it is wrong, they cannot tell that we know it too, and it is
// ACTIONABLE, so it makes them do something. Shipped instances:
//
//   • /my-teams          "Follow a team to build your hub"   (follows six)
//   • /fast-break        "connect a Top Shot wallet"         (has pinned one)
//   • /road-to-the-ring  same, copy-pasted
//   • /dashboard/history "No verified wallets yet"           (has verified one)
//   • trophy picker      "No owned moments found yet"        (owns thousands)
//   • /profile/edit      a blank editable form its own Save then wrote
//
// ── WHY COMPONENTS ARE IN SCOPE, correcting a documented claim ──────────────
// CLAUDE.md records that the ~53 client COMPONENTS are "deliberately NOT gated
// — the component gate measures them, so they are not a blind spot in the same
// way." That reasoning is about COVERAGE and it does not carry over to HONESTY.
// TrophyPickerModal lives in components/profile/**, is fully measured, and had
// THREE existing test files — and still told collectors they own no Moments.
// Coverage asks whether a line RAN, never whether the sentence it printed was
// TRUE. So this walks components/ as well as app/.
//
// ── WHY A RATCHET AND NOT A BAN ─────────────────────────────────────────────
// The population is 39 sites across 27 files, and most are NOT defects: a read
// that degrades to an omitted section understates, which is the safe direction.
// Banning the idiom would force a pointless rewrite of ~40 correct call sites
// and teach people to edit the guard. Freezing it stops the population growing
// while the copy sweep drains the ones that render claims.
//
// ⚠ WHAT THIS DOES NOT CLAIM. Passing says the idiom did not SPREAD. It says
// nothing about whether the surviving sites are honest — that is decided by
// what the empty value RENDERS AS, which no static check can see. The method
// that keeps working is sweeping the empty-state COPY, not the fetch code.

const ROOTS = ["app", "components"]

/**
 * The ceiling. Lower it when you convert a site to distinguish the two states;
 * NEVER raise it. It was 39 when this landed.
 *
 * ⚠ The RAW count is 43. The four-site gap is comments — this file's own header
 * quotes all three patterns, and the fixed call sites carry comments quoting the
 * shape they replaced — so a version without stripComments() would double-count
 * the very conversions the ratchet is meant to reward, and a future conversion
 * that documents itself would look like a REGRESSION.
 *
 * 39 -> 38 on 2026-08-16: ShareProfileButtons' `.then(r => r.ok ? r.json() :
 * null)` went with the removal of the "+50 Status earned" note (the rewards
 * program is not built out, so no surface may confirm an earn). The site was
 * removed rather than converted, which counts the same to this ratchet — the
 * population shrank.
 *
 * ⚠ RE-DERIVE THIS FROM THE FAILING no-slack ASSERTION, never by subtracting
 * your own conversions from the number you read earlier. It is a COUNT of a
 * shared population, and concurrent sessions move it: two sessions each
 * subtracting their own work from 33 both wrote a wrong number on 2026-08-16.
 */
/* ⚠ 38 -> 39 (2026-08-16): AN INCREASE, AND NOT BACKSLIDING — nothing regressed
 * and nothing was un-converted. The DETECTOR was undercounting: it decided
 * "is this a client file?" from a truncated prefix (`slice(0, 300)`) using `.includes`, which ALSO false-positives on a
 * comment that merely mentions the directive, so a page whose
 * `"use client"` sits behind a header comment classified as a SERVER file and
 * never entered the population. Detection now goes through
 * `__tests__/helpers/client-directive.ts`, which skips whitespace and comments
 * and checks the first STATEMENT. Measurement expanding is the one legitimate
 * reason a ratchet number moves the wrong way (same precedent as widening the
 * coverage-gate `include`). THE RULE IS UNCHANGED — down only from here. */
/*
 * ⚠ 39 -> 43 ON 2026-08-22, AND THIS IS A MEASUREMENT CHANGE, NOT A REGRESSION.
 * No new collapse site was written. This guard's local comment stripper blanked
 * block-before-line, hiding ~19.6k chars of CollectionAnalyticsClient.tsx; the
 * budget of 39 was therefore calibrated against a blanked corpus and matched the
 * blind count EXACTLY. With the shared stripper the same file shows 8 sites
 * rather than 4.
 *
 * ⚠ THE FOUR NEWLY-VISIBLE SITES WERE TRIAGED INDIVIDUALLY BEFORE THIS NUMBER
 * MOVED — raising a ratchet to green it is the documented wrong move. Lines 441,
 * 524, 590 and 663 of CollectionAnalyticsClient.tsx each `.then((r) => (r.ok ?
 * r.json() : null))` AND THEN DISCRIMINATE the null (`if (j) setData(...) else
 * setFailed(true)`), which is the honest contract. They match the regex on
 * SHAPE, not on defect — the pattern cannot see the branch that follows.
 *
 * ✅ ONE PRE-EXISTING FAIL-OPEN FOUND HERE WAS THEN FIXED (same day, separate
 * change): the `/api/ready` thin-volume notice in CollectionAnalyticsClient.tsx
 * ended `.catch(() => {})`, so an outage left the caveat unrendered and a
 * genuinely thin-volume market got no warning. Worse than a wrong number,
 * because that notice exists to TEMPER the analytics below it — suppressing it
 * silently overstated confidence in every figure on the page, and its output was
 * silence, so the failure was unfalsifiable. It now has a third state.
 *
 * ⚠ THE BUDGET DID NOT DROP FOR THAT FIX, AND THAT IS CORRECT, NOT AN OVERSIGHT.
 * This ratchet counts the `.then((r) => (r.ok ? r.json() : null))` SHAPE, which
 * the fixed site still has — what changed is the branch that follows it, which
 * the regex cannot see. Lowering the budget here would be claiming a reduction
 * the instrument did not measure.
 */
const BUDGET = 43

/**
 * A failure funnelled into the success-with-nothing value.
 *
 * ⚠ Deliberately NOT a bare `.catch(() => {})`: `videoRef.play().catch(…)` and
 * fire-and-forget telemetry match that and are not data reads at all, so
 * including them would bury the signal under ~27 false positives and make the
 * number meaningless as a debt measure.
 */
const COLLAPSE_SITE = new RegExp(
  [
    // .then((r) => (r.ok ? r.json() : null))
    String.raw`\.then\(\s*\(?\s*\w+\s*\)?\s*=>\s*\(?\s*\w+\.ok\s*\?\s*\w+\.json\(\)\s*:\s*(?:null|\[\]|\{\})\s*\)?\s*\)`,
    // await res.json().catch(() => null)
    String.raw`\.json\(\)\s*\.catch\(\s*\(\s*\)\s*=>\s*(?:null|\[\]|\{\})\s*\)`,
    // if (!res.ok) { setRows([]); return }
    String.raw`if\s*\(\s*!\s*\w*[Rr]es\w*\.ok\s*\)\s*\{[^}]{0,80}set\w+\(\s*\[\]\s*\)`,
  ].join("|"),
  "g",
)

function isClientFile(src: string): boolean {
  return isClientSource(src)
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      // app/api/** is the ROUTE tree, excluded because this guard is about CLIENT
      // components collapsing a failure into an empty render.
      //
      // ⚠ THE EXCLUSION IS RIGHT; THE REASON IT USED TO GIVE WAS NOT. It said
      // "already in the primary gate", and the primary gate is the vitest
      // COVERAGE gate — which measures whether lines EXECUTE, not whether errors
      // are handled. An unguarded `const { data } = await supabase…` has no error
      // branch to be uncovered, so a happy-path route test gives it 100% coverage.
      // Nothing was checking the route tree for this class, and on 2026-08-21 that
      // cost 7 live instances (4 in Fast Break, then cost-basis / market-movers /
      // edition-stats) plus a measured 259 reads that never destructure `error`.
      // Do NOT re-derive "app/api is covered" from this line.
      // See docs/overnight/inbox/2026-08-21T1945Z-259-route-reads-…
      if (entry === "api" && dir === join(process.cwd(), "app")) continue
      walk(full, out)
    } else if (entry.endsWith(".tsx") || entry.endsWith(".ts")) {
      out.push(full)
    }
  }
  return out
}

/**
 * Blank out comments, preserving offsets.
 *
 * ⚠ REQUIRED. This file's own header quotes all three patterns verbatim to
 * explain itself, and several of the FIXED call sites carry a comment quoting
 * the shape they replaced — so counting raw source double-counts the very
 * conversions this ratchet is meant to reward. At least the sixth instance of
 * this trap in this repo.
 */
/*
 * ⚠ MIGRATED 2026-08-22 to the ONE shared stripper (scripts/lib/strip-comments.mjs).
 * The local copy here stripped BLOCK comments before LINE comments, so an
 * ordinary line comment mentioning a glob path opened a block comment that ran
 * to the next close-comment anywhere in the file, blanking real source this
 * guard then reported as clean (103,590 chars across 49 product files).
 * Do not re-inline a local copy.
 */

function collapseSites(): { file: string; count: number }[] {
  const out: { file: string; count: number }[] = []
  for (const root of ROOTS) {
    for (const full of walk(join(process.cwd(), root))) {
      const raw = readFileSync(full, "utf8")
      if (!isClientFile(raw)) continue
      const n = (stripComments(raw).match(COLLAPSE_SITE) ?? []).length
      if (n > 0) out.push({ file: relative(process.cwd(), full).split(sep).join("/"), count: n })
    }
  }
  return out.sort((a, b) => b.count - a.count || a.file.localeCompare(b.file))
}

describe("client failure-collapses-to-empty ratchet", () => {
  const sites = collapseSites()
  const total = sites.reduce((s, f) => s + f.count, 0)

  it("the enumerator still sees the client tree (not vacuously passing)", () => {
    // ⚠ Asserts on the WALK, never on how many sites are still dirty. A
    // threshold on the dirty count goes RED the moment the population is driven
    // to zero — which is the goal — and this repo has already shipped that bug
    // once, in server-page-data-access-ratchet's `pages.length > 10`. A
    // not-vacuous check must be satisfiable at a population of ZERO.
    const clientFiles = ROOTS.flatMap((r) => walk(join(process.cwd(), r))).filter((f) =>
      isClientFile(readFileSync(f, "utf8")),
    )
    expect(clientFiles.length, "the walk must find client files").toBeGreaterThan(50)
  })

  it("the pattern actually matches the shape it names (guards the guard)", () => {
    // Without this, a typo in the regex reports zero forever and the ratchet
    // reads as active protection while measuring nothing.
    const specimen = `
      const a = await fetch(u).then((r) => (r.ok ? r.json() : null))
      const b = await res.json().catch(() => null)
      if (!res.ok) { setRows([]); return }
    `
    expect((specimen.match(COLLAPSE_SITE) ?? []).length).toBe(3)
    // ...and does NOT match the benign shapes, or the number is noise.
    const benign = `
      videoRef.current.play().catch(() => {})
      fetch("/api/track", { method: "POST" }).catch(() => {})
      const c = res.ok ? await res.json() : { rows: [], ok: false }
    `
    expect((benign.match(COLLAPSE_SITE) ?? []).length).toBe(0)
  })

  it(`no more than ${BUDGET} client sites collapse a failure into an empty value`, () => {
    expect(
      total,
      `Client failure-collapse sites grew to ${total} (budget ${BUDGET}).\n` +
        `A new client read must distinguish "we could not read" from "there is nothing" —\n` +
        `see lib/wallet/pinned-wallet.ts or lib/analytics/fetch-json.ts for the contract.\n` +
        `If you CONVERTED one, lower BUDGET in the same commit.\n` +
        sites.map((f) => `  ${f.count}  ${f.file}`).join("\n"),
    ).toBeLessThanOrEqual(BUDGET)
  })

  it("the budget is not left slack above the real number", () => {
    // A ratchet with headroom silently licenses the next N additions — the
    // compounding failure the component gate already paid for with a ~13-point
    // unguarded branch buffer.
    expect(
      BUDGET - total,
      `BUDGET is ${BUDGET} but only ${total} sites qualify — lower BUDGET to ${total}.`,
    ).toBeLessThanOrEqual(0)
  })
})
