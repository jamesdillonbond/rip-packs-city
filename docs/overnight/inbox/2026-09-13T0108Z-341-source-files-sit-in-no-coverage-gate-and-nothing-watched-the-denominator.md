# 341 source files sit in NO coverage gate — and until today nothing watched the DENOMINATOR

**2026-09-13T01:08Z (2026-09-12 18:08 PT) · Claude Code, cloud · re-derivation of the 2026-08-29 CI-audit item F, plus one guard shipped.**

---

## ⭐ THE SHIPPED HALF: a coverage percentage is a RATIO, and every existing guard watched the numerator

Three gates ratchet a coverage percentage. The thresholds red when coverage DROPS,
`coverage-gates-are-wired-to-ci.test.ts` checks the gates run in CI, and
`component-gate-include-completeness.test.ts` checks no new `components/` subtree is silently
ungated.

🚨 **Nothing watched the denominator.** Narrowing `lib/**/*.ts` to `lib/analytics/**`, or deleting
`app/**/route.ts` from an `include` array, removes hundreds of files from the measurement — and
because the files that remain are the well-tested ones, **the percentage goes UP and every
threshold passes.** The gate reports a better number for measuring less. That is this repo's
most-feared shape (a guard that inspected nothing, reading as a pass) turned on the coverage
gates themselves.

✅ **Shipped: `__tests__/coverage-gates-still-measure-what-they-claim.test.ts`** — four bans at
zero, one per surface the gates claim: every `lib/` module and every `app/**/route.ts` in the
primary gate, every `workers/` file in the workers gate, every `app/**/*Client.tsx` in the
component gate.

⚠ **Expressed over the TREE, not over a count, and that is the design decision.** A first cut
asserted *"the primary gate matches at least N files"*, which reds the day somebody legitimately
deletes N+1 files — **a ceiling that churns gets raised rather than read**. The property shipped
is *every file of this shape is matched*: invariant under ordinary additions and deletions, red
only when the globs themselves stop covering a surface.

⚠ **The globs are READ FROM THE CONFIGS, never restated in the test.** A copy would be a claim
about the configs that can go stale silently — the same failure one level up.

⭐ **Mutation-proven against the REAL config, not a fixture:** commenting out `"app/**/route.ts"`
in `vitest.config.ts` reds the guard and names the now-unmeasured routes; restoring greens it.
⭐ **And a commented-out glob correctly does NOT count as coverage** — the array is read through
`stripComments`, so the subtle death (the glob still visible in the file, so a reviewer skimming
the config sees the surface named) is caught. That path works because the shared stripper was
made JSX-aware and pinned to the TypeScript compiler earlier the same evening (register #87).

---

## ⚠ THE UNSHIPPED HALF: the census, re-derived and dated

The 2026-08-29 audit's item F measured this and nothing has acted on it. **Re-derived
2026-09-12 (PT) against the live tree** — do not quote the 08-29 numbers, two of them moved:

| bucket | files in NO gate | 08-29 | verdict |
|---|---:|---:|---|
| `app/**/page.tsx` | **116** | 119 | product surfaces, unmeasured |
| `scripts/**` | **105** | 93 | grown +12; **tested but unmeasured** |
| `app/**/layout.tsx` | **63** | 63 | product surfaces, unmeasured |
| `supabase/functions/*/index.ts` | **38** | 38 | **structurally unmeasurable** |
| `app/**` other `.tsx` | **12** | 58 | mostly gated since |
| `components/**` non-`.tsx` | **5** | — | the component globs only match `.tsx` |
| `app/**` other `.ts` | **2** | — | |
| **total** | **341 of 1,460** | | |

⛔ **NOT filed as "untested" — filed as UNMEASURED, and the distinction is load-bearing.**
**93 test files already import from `scripts/`** (24 on 08-29 — it nearly quadrupled). Tests
exist; what does not exist is any number saying how much is exercised, or a ratchet stopping it
falling.

⭐ **Two exclusions are justified, and both were RE-DERIVED rather than inherited:**

- **Edge functions: 38 of 38 use `Deno.*` globals, `serve()` or `std/http`** — measured this
  session, not quoted. None is importable by vitest, so a coverage `include` over them is not
  achievable without a second, Deno, toolchain. Ratcheting them would punish something
  unachievable.
- **`scripts/**`: dev tooling, high churn.** A ratchet here reds every time someone adds a
  one-shot script — the "permanently red arm" failure this repo already has a rule about.

## ⛔ WHY THE `app/` SURFACES ARE NOT RATCHETED EITHER, stated rather than quietly dropped

116 pages + 63 layouts is a standing debt, and a ceiling over it reds whenever anyone adds a
route. That is the same trained-to-ignore failure, so it would make things worse rather than
better. **The honest options are a product decision, not a wrap-up edit:**

1. Gate a NAMED subset (the insights boards are already partly gated this way — three
   `app/insights/*/page.tsx` globs sit in the component config), then ratchet only that subset.
2. Accept server pages as unmeasured by design and say so once, in the config, where the next
   reader meets it — rather than leaving it to be rediscovered by audit every few weeks.

⚠ **The cost of leaving it is concrete and has already been paid once:** `app/dashboard/layout.tsx`
was literally `return children`, which dropped the bottom nav from every route under `/dashboard`
and all ~30 boards under `/insights` — **a defect invisible to all three gates**, found by
Trevor on a phone, fixed 2026-09-12.

**EXIT:** pick (1) or (2). Until then the denominator guard above at least stops the measured
set SHRINKING, which is the direction that reads as improvement.
