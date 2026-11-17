> ## ✅ RESOLVED 2026-08-03 (Claude Code) — commit `484d08d7`, deploy READY, **cursor verified advancing `0 → 500` in prod**.
> Nothing here is outstanding. Kept as the diagnosis record. Two deviations from the plan below, both deliberate:
> - **Page size is 500, not the 900 this doc prescribes.** Runs average 181s against `maxDuration=300` and **23.6% of invocations (95 of ~402 in 72h) are killed at the wall** before writing a terminal row — a killed run retries the same offset, so 900 risked re-stalling the sweep at the first slow page. This doc's own "don't raise `maxDuration`, the route already pins the Pro maximum" is **wrong**: 300 is set, the Pro cap is **800**. Raising it is queued as a cost decision.
> - **Item 2's proposed arm direction was inverted.** `v_rpc_trust_health` scores `value >= breach_at`, so the proposed `distinct offsets < 2` would have read permanently green. Shipped (by Cowork) as `fmv_sweep_stall_pct_24h`, breach `>= 50`.
>
> Also corrected while draining this: the 3 boards behind `public_board_slow_count` are **not** the two named in Item 3 — see the ledger entry for 2026-08-03.

# Handoff — FMV recalc sweep is stuck at offset 0 (PostgREST row cap defeats the cursor)

**Date:** 2026-08-03 · **For:** Claude Code on Trevor's machine
**Last known HEAD:** `8e62cf26` (CI green, 8/8 jobs, per the 08-03 Claude Code pass)

---

## Context

Cowork found this from prod telemetry; **nothing has been shipped for it** — the fix is route code (`app/api/fmv-recalc/route.ts`), which Cowork cannot push. No migration is required for Item 1. Item 2 is a trust-health arm that Cowork *can* ship as a migration, but it is written up here so the two land together and you can veto the threshold.

This supersedes one conclusion in the 08-03 Claude Code pass. That pass closed Item 1 with:

> "Residual is propagation only — All Day snapshots average 70h old, so re-measure after 2026-08-08."

**Propagation will not complete.** The sweep that would propagate it has not advanced past its first page since the cursor was introduced. Re-measuring on 08-08 would have shown the same numbers and been read as a second confirmation.

---

## Item 1 — `fmv-recalc` reprocesses the same ~1,000 editions every run, forever

**File:** `app/api/fmv-recalc/route.ts` (86,103 bytes, mtime 2026-07-24 — not touched by the last two overnight passes, so no collision)

### Root cause

The route paginates the catalogue with a cursor persisted in `pipeline_runs.cursor_after` (lines ~128–152), and computes whether more pages remain at line ~1701:

```ts
const DEFAULT_LIMIT = 2500                                  // line 37
const limit = Math.min(Number(body.limit ?? DEFAULT_LIMIT), 5000)   // line 126
...
const hasMore = pageEditionIds.length === limit             // line 1701
...
p_cursor_after: hasMore ? String(offset + limit) : null,    // line 1722
```

`fmv_recalc_edition_page` is called over PostgREST (`supabaseAdmin.rpc(...)`, line 224). **PostgREST caps RPC result sets at `db-max-rows` = 1000.** The function is asked for 2,500 rows and returns 1,000. So:

`pageEditionIds.length` (1000) `=== limit` (2500) → **false** → `hasMore = false` → `cursor_after = null` → the next run's cursor read finds null → `offset = 0`.

Every run re-prices the top ~1,000 editions by most-recent-sale and never advances.

The code comment at lines 128–134 documents this exact failure being diagnosed and fixed on 2026-05-23 ("without a persisted cursor every run reprocessed page 0, so ~95% of editions were never recomputed"). The cursor was added correctly; the row cap silently re-broke it, and it has been broken ever since with `ok = true`.

### Verified evidence (read-only, prod, 2026-08-03 ~20:00 UTC)

| Check | Result |
|---|---|
| `pipeline_runs` for `fmv-recalc`, last 20h, every row | `cursor_before='0'`, `cursor_after=NULL` — no exceptions |
| `rows_written` per run | **997, 997, 997, 997, 875, 996, 996, 996, 997, 997** — pinned just under 1,000 |
| Distinct editions with a sale in the 30d window (the sweep's full population) | **11,602** |
| Fraction reachable per run | ~1,000 → **74% of the actively-traded catalogue is never recomputed** |
| Top Shot latest-snapshot average age | **456.8 h (19 days)**; max **1,505 h (63 days)** |
| Top Shot editions recalculated in the 17h since the dust-floor deploy | **2,432 / 19,447 (12.5%)** |

Dust-floor propagation, split on whether the current snapshot post-dates the fix (`≥4` sales in 30d; ratio = published FMV ÷ that edition's own 30d realised median):

| Collection | Cohort | Editions | median | p90 | >2× |
|---|---|---|---|---|---|
| Top Shot | post-fix | 1,317 | **1.000** | **1.124** | **2** |
| Top Shot | pre-fix | 3,011 | 1.006 | 1.889 | **264** |
| All Day | post-fix | 197 | **1.000** | **1.226** | **6** |
| All Day | pre-fix | 1,361 | 1.000 | 3.000 | **194** |

Median time since last sale: post-fix cohort **17.8 h**, pre-fix cohort **100.9 h** — the signature of a recency-ordered page that never advances.

**Live blast radius: 458 editions (264 TS + 194 AD) currently publish an FMV more than 2× their own 30-day realised median.** The dust-floor fix is correct — the post-fix cohorts land on the unfloored `cold-tail` control — but it reaches only the head of the order book.

### The change

Make the page size smaller than the PostgREST cap so `hasMore` is computable, and make the comparison defensive:

1. **Line 37:** `const DEFAULT_LIMIT = 2500` → `const DEFAULT_LIMIT = 900`
2. **Line 126:** `Math.min(Number(body.limit ?? DEFAULT_LIMIT), 5000)` → cap at `900`, not `5000`, so a manual `body.limit` can't reintroduce the truncation:
   `const limit = Math.min(Number(body.limit ?? DEFAULT_LIMIT), 900)`
3. **Line 1701:** `=== limit` → `>= limit` (defensive; with limit < 1000 the equality would work, but `>=` cannot silently fail this way again)
4. **Add a truncation tripwire** immediately after `pageEditionIds` is built (~line 260). If the page comes back at exactly 1000 while `limit > 1000`, that is the PostgREST cap, and it must be loud rather than inferred:

```ts
if (pageEditionIds.length === 1000 && limit > 1000) {
  console.error(
    `[FMV-RECALC] PostgREST row cap hit: requested ${limit}, got exactly 1000. ` +
    `Sweep cursor cannot advance. Reduce DEFAULT_LIMIT below 1000.`
  )
}
```

Also worth adding `page_size: pageEditionIds.length` and `has_more: hasMore` to the `p_extra` payload at line ~1723 — the current `extra` records haircut counts and wash-trade counts but not the one number that would have shown this.

### Expected effect

11,602 ÷ 900 ≈ **13 pages**. `fmv-recalc` fires ~3–4×/hour, so a full catalogue sweep completes in **~3.5–4.5 hours** and thereafter re-baselines continuously. Watch `cursor_before` climb 0 → 900 → 1800 → … → null (wrap) → 0.

**Do not raise `db-max-rows` instead.** It is a global PostgREST setting and every other `.rpc()` caller in the codebase is currently written against the 1000-row reality.

### Revert path

Single-file, single-commit. `git revert <sha of this commit>` restores `DEFAULT_LIMIT = 2500` and the `===` comparison. No DB state is written that needs undoing — the sweep simply returns to reprocessing page 0. Snapshots written while it was working are valid and stay.

### Verification

- `npx tsc --noEmit` clean.
- Vercel deploy READY.
- **~40 minutes after deploy**, run:

```sql
SELECT started_at, rows_written, cursor_before, cursor_after
FROM pipeline_runs
WHERE pipeline = 'fmv-recalc' AND started_at > now() - interval '1 hour'
ORDER BY started_at DESC;
```

Expect `cursor_before` to differ between runs and `cursor_after` to be non-null on all but the wrap run. **`cursor_before='0'` on two consecutive runs means the fix did not take.**

- **~6 hours after deploy**, re-run the pre/post split above. Expect the pre-fix cohort to collapse toward zero and the >2× counts (264 TS / 194 AD) to fall with it.

---

## Item 2 — no monitor could see this, and one arm is calibrated to the broken state

> **✅ The new arm is already shipped** — Cowork applied `audit_20260803_fmv_sweep_stall_trust_arm` and `audit_20260803_fmv_sweep_arm_restore_security_invoker` on 2026-08-03. `fmv_sweep_stall_pct_24h` reads **100.0 → BREACH**. Nothing for Claude Code to do here except the re-baseline noted at the end. Retained below because it explains why the existing arms stayed green.

`v_rpc_trust_health` read **30/32 ok** before this session. Neither breach was this.

- `topshot_fmv_stale_hours = 0.1` → **ok** (breach at 6). It reads only the freshest row. A sweep pinned to the top 1,000 most-recently-traded editions writes fresh rows constantly, so this metric is *structurally incapable* of seeing the stall. Its own `catches` text says as much.
- `topshot_fmv_pct_stale_30d = 32.2` → **ok** (breach at 50). This arm was built precisely to catch "a partial/selective writer stall the freshness sentinel structurally cannot see" — the right idea. But its documented baseline is **32.3% on 2026-07-25**, and it reads 32.2% today. **The baseline was measured while the sweep was already stuck**, so the arm was calibrated to the broken steady state and set to breach 18 points above it. It will never fire, because a permanent plateau produces no trend.

Once Item 1 ships, `topshot_fmv_pct_stale_30d` should fall materially. **Re-baseline it after the first full sweep and lower `breach_at` to roughly 1.5× the new floor** — otherwise the arm stays decorative.

The arm as shipped:

```
fmv_sweep_stall_pct_24h
  = share of fmv-recalc runs in 24h that started at cursor_before='0'
  breach_at: >= 50      -- healthy 13-page sweep ≈8%; stuck = 100%
                        -- 999 when there are no runs at all: absence must not read as health
```

This is the metric that would have caught it on day one, and it cannot be fooled by a fresh write. **After your fix deploys it should fall to roughly 8% and go green on its own** — if it stays at 100, the cursor is still not advancing.

⚠ One thing to carry: the `CREATE OR REPLACE VIEW` **dropped `reloptions` again**, verified NULL immediately afterwards and restored with `ALTER VIEW public.v_rpc_trust_health SET (security_invoker = on)`. Second occurrence in three days. Treat the `ALTER VIEW` as a mandatory paired statement on any future change to this view, not a cleanup step.

**Do not raise either existing threshold to clear a breach** — standing guardrail, and both current breaches are honest.

---

## Item 3 — carried, unchanged, lower priority

- `public_board_slow_count = 3` (breach at 1) — **new since the 07-31 roadmap**, which recorded all 45 boards clean on 08-01. The arm's own text names `topshot_perfect_mint_premiums_board` (14.8s warm) and `topshot_pack_reality_dist` (8.4s) as long-standing true findings. Worth identifying the third before it renders empty; this arm is designed to warn *before* failure, so it is doing its job.
- `unmapped_resolution_backlog_max = 105` (breach at 100) — honest, carried. The agreed fix remains a permanent-failure *reason* the resolver records and the arm excludes by, not a higher `breach_at`.

---

## Guardrails (repeat every handoff)

- **Direct to `main`.** No branches, no PRs. If a `claude/*` branch is pre-checked-out, switch to `main` first.
- **Commit via PowerShell `git`** — Git Bash `git commit` can silently no-op. Re-verify with `git rev-list --count origin/main..HEAD` (expect `0`).
- **`curl` fails silently in Git Bash for Vercel REST** — use PowerShell `Invoke-WebRequest`.
- **Vercel Pro `maxDuration` hard cap is 800s** — higher sends the deploy to ERROR invisibly. This route already pins the Pro maximum; don't raise it.
- **CRLF:** don't string-replace-patch on Windows. Full-file write, or `findIndex` on split lines.
- **Log to `docs/overnight/ledger.md`** with the revert path, in the same turn it ships. Re-read the ledger from disk immediately before writing (append-at-top, written concurrently). **Commit the ledger before the code** so the code commit is the tip and auto-deploys.
- ⚠ **Git history was rewritten 2026-08-03** (credential purge, force-push). Every `git revert <sha>` in the ledger predating that is an invalid SHA — find old commits by message, not hash. The revert path in Item 1 refers to *your new* commit and is unaffected.

**Claude Code's direct file inspection wins over this doc and over `project_knowledge_search` on any disagreement — adapt to the actual file shape.** Line numbers here are from the 2026-07-24 mtime copy; if `DEFAULT_LIMIT` or `hasMore` has moved, trust the file.

---

## Ledger entry for the two migrations Cowork already shipped

Cowork does not append to `docs/overnight/ledger.md` from the mount (append-at-top, written concurrently — clobber risk). **Paste this at the top of the ledger with your commit**, alongside your own entry for the route fix:

```markdown
### 2026-08-03 — `fmv_sweep_stall_pct_24h` trust arm (Cowork, DB-only)

Added a `v_rpc_trust_health` arm that catches the fmv-recalc sweep restarting at page 0.
Board 32 → 33 arms, 2 → 3 breaches. New arm reads 100.0 → BREACH (correct — the sweep
is stuck pending the route fix). Spliced via guarded DO block that RAISEs if the marker
is not found exactly once, so the 30KB view definition was never hand-transcribed.

- `audit_20260803_fmv_sweep_stall_trust_arm` — CREATE OR REPLACE VIEW public.v_rpc_trust_health
- `audit_20260803_fmv_sweep_arm_restore_security_invoker` — ALTER VIEW ... SET (security_invoker = on)

⚠ The CREATE OR REPLACE dropped `reloptions` to NULL (verified), restored by the second
migration. Second occurrence in three days — pair the ALTER with any future change to this view.

Verified after: reloptions = {security_invoker=on}; check_public_security_invariants() = [];
check_secdef_anon_execute_violations() = [].

REVERT: re-run CREATE OR REPLACE VIEW from the pre-splice definition, then re-apply
ALTER VIEW public.v_rpc_trust_health SET (security_invoker = on);
The arm is additive and read-only — leaving it in place is harmless.
```

Also worth recording as **closed, not open**: `submit_allow_list_request` anon `EXECUTE` was carried in the 07-31 roadmap as an unshipped pre-launch item. It is already revoked — live grants are `postgres` and `service_role` only, no second overload, `check_secdef_anon_execute_violations()` returns `[]`. Nothing to ship; strike it from the queue.

---

## Expected end state

One commit on `main`, deploy READY, `npx tsc --noEmit` clean. Within an hour, `fmv-recalc.cursor_before` advancing across runs instead of pinned at `0`. Within ~6 hours, the pre-fix FMV cohort drained and the 458 editions publishing >2× their own realised median substantially gone. That is Gate 1 item 1 — the one thing every other accuracy number on the roadmap is measured on top of.
