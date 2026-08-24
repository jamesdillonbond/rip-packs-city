# RPC Operational Improvement Review — 2026-06-26

Scope: how we *operate* RPC over the last few weeks — the autonomous monitor/nightly/weekly stack, skills, artifacts, scheduled tasks, crons/GHAs, and repo/doc organization. Goal: expedite the work, cut errors, drive efficiency. Read on desktop.

## Executive summary

The machinery is mature and mostly working: a read-only daytime monitor → 1am nightly autonomous pass → weekly health/QA/dependency/strategy cadence, backed by 16 artifacts, 13 GHAs, ~23 cron-job.org entries, and a good library of `rpc-*` skills. The clean-night streak and the post-ship-watch discipline are real wins.

The drag is no longer capability — it's **friction that compounds on every single run**:

1. **Context bloat.** `CLAUDE.md` is 317 KB / 1,528 lines and **~60% of it (911 lines) is the inline "Recent sessions" log**, all of June. `docs/overnight/ledger.md` is **467 KB / 957 lines** (and Cowork edits to it truncate — a known hazard). Every session — daytime CC, the nightly pass, Cowork, ad-hoc — pays this load tax in latency and cost.
2. **Repeated manual health-sweeping.** The monitor, the nightly pass, and the weekly check each re-derive the *same* ~15-metric health vector via many separate SQL calls, every run. No single source of truth for "is the platform green."
3. **Recurring environment hazards.** Sandbox clock skew, the `/tmp` uid-squash, and NUL-corrupted `.git/config` get re-discovered and re-worked nearly every night instead of being handled by a deterministic pre-flight.
4. **Doc sprawl.** 259 handoff files sit in flat `docs/` (only 12 archived); session rotation stalled at May.

The five highest-ROI moves: **(1) rotate CLAUDE.md sessions + split the ledger**, **(2) automate that hygiene on a schedule so it stops re-accumulating**, **(3) build one `rpc_ops_snapshot()` health RPC**, **(4) codify the nightly pre-flight**, **(5) archive shipped handoffs**. Tiers below are ordered by ROI.

---

## Tier 1 — Context hygiene (taxes every run; highest ROI)

### 1. Rotate `CLAUDE.md` "Recent sessions" → `docs/sessions/` — *folder org / process*
**Evidence:** The Recent-sessions block is **911 of 1,528 lines** of CLAUDE.md. The archival pattern already exists (`docs/sessions/2026-04.md`, `2026-05.md`) but **hasn't run since May 8** — all of June is inline.
**Fix:** Move June entries to `docs/sessions/2026-06.md`; keep only the last ~7 days inline plus a one-line pointer ("older sessions archived to `docs/sessions/`"). Roughly halves CLAUDE.md.
**Impact:** Every session loads ~150 KB less. This is the single biggest cost/latency win and it benefits the autonomous tasks most (they run dozens of times a week).
**Risk:** Low, but CLAUDE.md is load-bearing and the file is large enough that a Cowork edit risks truncation. Do it as a careful, verified operation (write → re-read → confirm tail), not a blind rewrite. Live links from the rotated entries to `docs/handoff-*.md` should move *with* the text (so do this **before** #5).

### 2. Split / rotate `docs/overnight/ledger.md` — *folder org / process*
**Evidence:** 467 KB / 957 lines; memory records that editing it from Cowork truncates it ("don't edit the ledger from Cowork").
**Fix:** Keep `ledger.md` to **Open + Queued + Declined + last ~14 days Shipped**; roll older Shipped into `docs/overnight/ledger-archive-2026-H1.md` (append-only, frozen). Add a one-line header pointer.
**Impact:** Removes the truncation hazard *and* speeds every nightly pass (it reads/appends the ledger each run).
**Risk:** Low — archive is frozen history, current file stays the working surface.

### 3. Archive shipped handoffs — *folder org*
**Evidence:** **259** handoff files in flat `docs/`; only **12** archived. 28 are transient `*-overnight-pass.md`. Range goes back to 2026-05-24.
**Fix:** `git mv` shipped/landed handoffs older than ~14 days into `docs/archive/handoffs/` (the dir exists). Sequence **after #1** so live CLAUDE.md links don't break. Keep last ~7 days + any genuinely-active handoffs in root.
**Impact:** `docs/` drops from 293 files; Glob/Grep get faster and "what's active" stops being ambiguous.
**Risk:** Low if sequenced after the session rotation; medium if done blind (breaks live links).

### 4. Fix the auto-memory budget overflow — *memory / process*
**Evidence:** The loaded `MEMORY.md` is **25.5 KB vs a 24.4 KB limit — "only part was loaded"** (system reminder). Index lines are 200+ chars. A monthly consolidation task exists (`rpc-monthly-memory-consolidation`) but isn't enforcing the budget.
**Fix:** Trim index lines to <~160 chars (push detail into the topic files, which already exist); update the consolidation task's mandate to **explicitly enforce total <24 KB and per-line length** every run, not just "merge duplicates."
**Impact:** The whole memory index actually loads again — today it's silently truncated, so recalled facts are incomplete.
**Risk:** Very low.

### 5. Automate the hygiene above on a schedule — *scheduled event (NEW)*
**Evidence:** The 06-22 Cowork "asset audit" already did a chunk of this (deleted 14 spent one-offs, trimmed memory, retired artifacts) — and it's **already re-accumulated** four days later (new spent one-offs, June sessions inline, ledger at 467 KB). One-time cleanups don't hold.
**Fix:** Add a **biweekly `rpc-context-hygiene`** scheduled task (or fold into the existing Monday `rpc-weekly-health-report`, which already regenerates from CLAUDE.md so it's the natural owner): rotate CLAUDE.md sessions >10 days old, roll the ledger, archive handoffs >14 days, prune spent one-off scheduled tasks, and assert the memory budget. Each step verified, docs-only.
**Impact:** Turns a recurring manual chore into a standing guarantee; bloat stops being a periodic fire.
**Risk:** Low — all docs-only, idempotent, no production surface.

---

## Tier 2 — Error reduction (recurring failure classes)

### 6. Consolidated `rpc_ops_snapshot()` health RPC — *DB function + skill (NEW)*
**Evidence:** The daytime monitor, nightly pass, and weekly check each re-derive the same vector — `check_public_security_invariants`, `detect_stalled_pipelines`, `get_pipeline_alerts`, `v_rpc_trust_health`, sentinel UUID-48h, editions-per-collection, FMV HIGH+MED-per-collection, DB size, open unmapped, 24h pipeline fails — as **many separate calls, every run**, with the metric set defined only implicitly across three SKILL.md prompts (drift risk).
**Fix:** One SECDEF `rpc_ops_snapshot()` returning the full vector as a single JSON row (service_role only; follow the `rpc-migration` checklist — revoke anon EXECUTE, grants on CREATE OR REPLACE). It becomes the canonical "green?" probe and makes `metrics-latest.json` a one-call diff. Add the query to the `rpc-data` skill so every session uses the same definition.
**Impact:** Fewer tool calls and DB round-trips per monitor/nightly run; one definition of "green" instead of three; trivial baseline diffing.
**Risk:** Medium (shared infra the autonomous tasks depend on) — build + verify against the live function signatures, wire the three tasks to it deliberately, keep the old queries until parity is confirmed.

### 7. Codify the nightly pre-flight (clock / git / lock) — *skill / SKILL.md hardening*
**Evidence:** The pass re-discovers the same hazards almost nightly: **~5.5 h sandbox clock skew** mis-judged the quiet-hours window on 06-23/24/25 (caught only by manually cross-checking DB `now()` against app-stamped row timestamps); the **`/tmp/rpc` uid-squash** recurred 06-22 and 06-26 ("re-homed to `$HOME/rpcwork`"); **NUL-corrupted `.git/config`** hit 06-01 and 06-08.
**Fix:** A deterministic pre-flight as **step 0** of the nightly SKILL.md (or a small `rpc-nightly-preflight` skill): (a) establish real time via the DB-`now()`-vs-app-stamped-row check *first*, gate MONITOR-MODE on it; (b) clone to `$HOME/rpcwork`, never `/tmp`; (c) run the existing `check-tree-corruption.mjs` guard; (d) confirm push creds + `.lock` state. Most of this is already prose in CLAUDE.md — making it a fixed checklist removes per-night variance and the off-window-ship risk.
**Impact:** Eliminates the most common source of nightly re-work and the one real correctness risk (shipping off-window).
**Risk:** Low.

### 8. Fix the `/tmp` clone target in the nightly task prompt — *scheduled event (quick fix)*
**Evidence:** The pass keeps "re-homing to `$HOME`" because the documented clone path still points at `/tmp`, which uid-squashes to `nobody`.
**Fix:** One-line edit to the `rpc-nightly-autonomous-pass` SKILL.md: clone to `$HOME/rpcwork` directly. (Subset of #7, but worth calling out as a 2-minute fix.)
**Impact:** Removes a recurring stumble outright.
**Risk:** None.

---

## Tier 3 — Tidying / lower ROI

### 9. Prune spent one-off scheduled tasks — *scheduled event*
**Evidence:** Four fired-and-disabled one-offs still clutter the list: `candy-audit-interim-june22`, `pack-sniper-24h-low-verify`, `verify-mv-pgcron-first-tick`, `verify-allday-backfill-first-tick`. The 06-22 pass deleted 14; they re-accumulate because nothing prunes them.
**Fix:** Delete them; fold "prune spent one-offs" into the hygiene task (#5). *(Note: the current tool surface can disable but not delete scheduled tasks — deletion is an operator action or needs the delete capability.)*
**Impact:** Cleaner task list, less noise when scanning what's scheduled.
**Risk:** None (they've already fired).

### 10. Retire the two tombstone artifacts + scheduling-drift glance — *artifact / cron*
**Evidence:** `pack-drops-ev-check` and `rpc-ts-data-mission` are retired tombstones still in the manifest (14 of 16 artifacts are live). Separately, 13 GHAs + ~23 cron entries + pg_cron jobs have no single map; the 06-07 stagger fixed pile-up but drift will recur.
**Fix:** Remove the two tombstones from the manifest. Give the existing `rpc-dependency-advisory-digest` (or weekly check) a short "scheduling map / drift" section so cron/GHA/pg_cron overlap is reviewed on a cadence rather than ad-hoc.
**Impact:** Minor; keeps the surface-QA artifact validation honest and prevents silent cron collisions.
**Risk:** Low.

---

## Suggested execution order

1. **#8** (2-min `/tmp`→`$HOME` fix) and **#4** (memory budget) — trivial, immediate.
2. **#1 → #2 → #3** (CLAUDE.md sessions, then ledger, then handoffs) — sequenced so links don't break; the big context win.
3. **#5** — stand up the hygiene scheduled task so 1–3 never re-accumulate.
4. **#6** — build + wire `rpc_ops_snapshot()` (own focused pass, migration discipline).
5. **#7** — fold the pre-flight into the nightly SKILL.md.
6. **#9 / #10** — tidy when convenient.

## Notes / non-goals

- These are *operational* improvements; none touch FMV/pricing/auth/secrets or the off-limits route logic.
- The autonomous stack itself is healthy — this is about reducing its per-run cost and variance, not redesigning it.
- Precedent: this mirrors the 2026-05-30 `docs/ops-qa-improvement-review-2026-05-30.md` pass; several of its outputs (the `rpc-*` skills, the live artifacts) are exactly why the operation is in good shape today.
