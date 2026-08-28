# ✅ D30 — three production-dead components removed, and the reason they survived is a **same-named live sibling**

**Filed 2026-08-27 19:2xZ PT (2026-08-28 02:2xZ) by Claude Code, cloud session (push-capable).**
Closes register item **D30** (first seen 2026-08-09), and records **two things D30 does not**: why the
dead code was invisible to an ordinary grep, and that one of the three API routes behind it is dead too.

---

## 1. ✅ D30 confirmed — with an instrument that was controlled first

D30 is nearly three weeks old, and CLAUDE.md's rule is that **a filed finding is a hypothesis**. Re-derived
by resolving every `from "…"` specifier to an absolute module path (relative and `@/` alike) rather than
grepping for a name:

| component | production importers | test importers |
|---|---:|---:|
| `components/InsiderSignals.tsx` | **0** | 1 |
| `components/profile/TierBreakdownCard.tsx` | **0** | 1 |
| `components/profile/PortfolioSparkline.tsx` | **0** | 1 |

⭐ **Positive controls, because a resolver that silently matched nothing would report the same zeros:**
`components/analytics/InsiderSignals.tsx` → **1** production importer (`app/(analytics)/analytics/page.tsx`),
`components/InsiderSignalsPanel.tsx` → **1** (`CollectionOverviewClient.tsx`). The detector can see a live
importer, so the three zeros are real. No `next/dynamic`, `lazy()` or `import()` references either.

## 2. 🚨 Why it survived three weeks: a same-named LIVE sibling

**`components/InsiderSignals.tsx` is dead. `components/analytics/InsiderSignals.tsx` is live.** Same
basename, different directory.

⚠ **My own first pass got this wrong** — a `grep -rl "InsiderSignals"` reported **seven** "importers",
every one of them either the live sibling, an API route whose *path* contains the word, or a type name.
**Anyone who spot-checks this item with a name grep will conclude it is live and move on**, which is a
complete explanation for why a P3 sat open while looking closed.

⭐ **The general rule: for a dead-code claim, grep the RESOLVED MODULE PATH, never the identifier.** An
identifier is shared; a path is not.

## 3. ⭐ The tests existed because the components were at 0% — so the gate covered dead code

Each deleted test says so in its own header. `component-InsiderSignals-toplevel.test.tsx` opens:

> *"components/InsiderSignals.tsx (the top-level widget, distinct from the tested
> components/analytics/InsiderSignals panel) **was at 0%**."*

So **the component coverage gate was satisfied by writing tests for code nothing in production imports** —
122, 88 and 111 lines of test driving three unmounted widgets. That is not a lint failure; it is the gate
being structurally silent about whether the code it measures is *reachable*. ⚠ **A coverage gate cannot
tell "covered" from "covered and dead"**, and the cheapest way to raise it is therefore to test the dead
half. ✅ The gate still passes after removal (`test:coverage:components` exit 0).

## 4. 🚨 NEW — one of the three API routes is dead too, and it is NOT recorded in D30

| route | other callers | verdict |
|---|---|---|
| `/api/insider-signals` | `components/InsiderSignalsPanel.tsx` (live) | route LIVE |
| `/api/profile/portfolio-history` | `ProfileClient.tsx`, `CollectionProfileClient.tsx` (both live) | route LIVE |
| **`/api/profile/tier-breakdown`** | **none — `TierBreakdownCard` was its only caller** | **route now ORPHANED** |

⛔ **Not deleted.** Repo callers can be enumerated; **cron-job.org, the Task Scheduler and any external
client cannot be**, and CLAUDE.md counts those as the seventh and eighth caller sources precisely because
they are invisible here. Removing a reachable HTTP endpoint on repo evidence alone is a step a sweep should
not take. **Filed so the decision can be made with the dead-component half already done.**

## 5. ⚠ Two traps this removal walked into, both caught by the repo's own guards

1. **`scripts/check-brand-tokens.mjs` names its protected files individually**, and deleting one made it
   exit 1 in CI with *"protected file missing (rename?)"*. ⭐ **That is CLAUDE.md's "a guard that NAMES its
   instances — three have died on a rename" firing as designed rather than silently** — it even carries a
   `PROTECTED lists are not stale` test. Entry removed; the guard is green.
2. **`app/api/profile/portfolio-history/route.ts` justified being DELIBERATELY PUBLIC by naming
   `PortfolioSparkline.tsx` as its caller** — a file this commit deletes. 🚨 **Leaving that would have
   pointed the next reader at a deleted component as the sole reason a public route exists, which is how a
   live route gets removed as orphaned.** The comment now names the two clients that actually fetch it.

## 6. ⚠ Not claimed

- **Why each component was unmounted is not established.** They may be pre-launch, may have been unmounted
  in a redesign; nothing here recovers that history.
- **This does not generalise to a sweep.** Three components were verified individually with controls; the
  wider population of possibly-dead components was not measured.

## 7. Revert path

`git revert` the commit — it restores the three components, their three tests, the brand-token list entry
and the original comment. No DB state, no route deleted, no schedule change.
