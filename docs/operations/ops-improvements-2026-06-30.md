# RPC operational improvements — review 2026-06-30

Grounded review of the autonomous-ops estate (scheduled tasks, skills, artifacts, crons, GHAs, folder org) after ~3 weeks of high-velocity work (**571 commits / 21 days**). The system is dense and healthy; nearly every win below is **consolidation or killing a recurring manual tax**, not new machinery. Do NOT read this as "add more tasks" — the estate is already at 23 scheduled tasks.

Effort/owner key: **[now]** = Cowork can do safely this session · **[SKILL]** = edit a task's SKILL.md · **[CC]** = code/route · **[Trevor]** = manual.

---

## Tier 1 — Kill the recurring nightly manual taxes (highest leverage)

These recur *every single overnight/monitor run*. Each is a judgment call being re-derived from scratch; each can become a deterministic step.

### 1. Clock-skew: stop trusting shell `date`; anchor time to the DB. [SKILL]
Evidence: "clock skew" appears ~28× across the ledger/CLAUDE/sessions; 06-24/25/27 passes each spent cycles detecting the recurring ~5.5h sandbox-vs-real skew by cross-referencing app-stamped rows. It's already half-codified in the `.lock` prose.
**Fix:** make the first action of `rpc-nightly-autonomous-pass` (and `rpc-daytime-monitor`, `rpc-context-hygiene`) a required time-anchor step: read `SELECT now()` + `max(ingested_at)` via Supabase MCP, treat **that** as authoritative, never trust shell `date`, and derive the in-window/off-hours/genuine-overnight decision from DB time. Converts a recurring forensic check into one deterministic line.

### 2. Stale-doc / schema-truth footgun: generate volatile facts, don't hand-maintain them. [CC + SKILL]
Evidence: "stale/footgun" ~102× in ledger+CLAUDE. The dropped `pinnacle_fmv_snapshots` table name alone resurfaced as a live-query footgun across 06-28 and 06-29. Root cause: CLAUDE.md inlines volatile schema facts (table names, which table holds FMV per collection, enum values, RLS state) that drift from the live DB — and `rpc-data` can't be edited from Cowork.
**Fix:** fold a generator into the existing **weekly `rpc-data-quality-sweep`**: regenerate `docs/reference/schema-truth.md` from live `information_schema` (table existence, FMV home per collection, enum casings, RLS-on count) and **diff it against the facts inlined in CLAUDE.md / rpc-data**, flagging drift to the ledger. Then thin CLAUDE.md's "verify before writing queries" block to point at the generated doc instead of duplicating it. Kills the whole class instead of patching each instance.

### 3. Post-ship watch: templatize it. [SKILL, optionally new skill]
Evidence: "post-ship watch" ~57×. Every night the pass re-verifies the prior day's CC commits — valuable, but reconstructed in prose each time. `rpc_ops_snapshot()` already returns the whole health vector in one call.
**Fix:** a fixed checklist (section in the nightly SKILL, or a small `rpc-post-ship-watch` skill) keyed off the day's commit range: `git log --since`, then per touched surface run the standard probe (security invariants → the specific view's `security_invoker` → the named metric delta) into a PASS/FAIL table. Same rigor, less reinvention, more consistent output.

---

## Tier 2 — Context/folder hygiene (everything is bloated; it taxes every session's load)

The `rpc-context-hygiene` task (biweekly) rotates CLAUDE.md / ledger / handoffs well — but has **three coverage gaps**, and the docs root has outrun it.

### 4. `focus.md` is unmanaged and accreting. [SKILL]
Measured: 23.9KB, **14 dated section headers**, top header says 06-24 but content runs to 06-30, with 06-18/19/22 sections still inline. The hygiene skill rotates CLAUDE.md/ledger/handoffs but **never touches focus.md** — so it grows unbounded and is read every night.
**Fix:** add focus.md pruning to the hygiene pass — keep the current steer + the "STANDING" notes, drop dated sections older than ~7 days. Target ~3–5KB.

### 5. `docs/` root clutter: 177 handoff files in root. [SKILL]
Measured: 216 files in `docs/` root, **177 of them `handoff-*`** (175 dated June), while `docs/archive/handoffs/` only holds 119. The hygiene policy ("archive >14d, keep last 7d") isn't keeping up — biweekly cadence vs multiple handoffs/day.
**Fix:** tighten to "keep last ~7 days in root, archive the rest," and move the cheap `git mv` archival into the **nightly pass** (archive handoffs it just drained) rather than waiting for the biweekly. Target: <20 files in `docs/` root.

### 6. `MEMORY.md` is over budget *right now*. [now]
The system loads it every session and it's **28.1KB vs the 24.4KB limit — only partially loaded this session** (degrading recall already). The monthly consolidation (fires tomorrow, 07-01) helps, but the structural issue is index-line length.
**Fix:** (a) I can trim the index lines under budget now; (b) enhance `rpc-monthly-memory-consolidation` to enforce a hard per-line cap (~160 chars) on MEMORY.md index entries, pushing detail into topic files.

### 7. `ledger.md` is 456KB and read *in full* every night. [SKILL]
The nightly pass reads the whole ledger before acting (its own header mandates it). Already has an H1 archive, but the Shipped section still carries weeks of history.
**Fix:** roll the Shipped section at >7 days (not >14), and/or split the always-needed part (Declined + Queued) into a small `ledger-active.md` the pass reads fully, leaving Shipped history in the archive it only greps. Cuts the nightly read from ~456KB to a few KB.

---

## Tier 3 — Reliability / consolidation

### 8. Finish the cron-job.org → GitHub Actions migration. [CC, already queued]
The 23 cron-job.org pipelines carry documented, recurring pain: the 30s execution cap, the "200 that's actually /login" auth gotcha, and the secret-in-DOM leak hazard (a session once leaked `INGEST_SECRET_TOKEN` reading a job-edit page). The 06-27 backstop GHAs (`sales-indexers-backstop`, `wallet-backfill-backstop`, `snapshot-institutional-wallets-backstop`) prove the pattern works.
**Fix:** prioritize the already-queued "cron→GHA-decouple pt2." GHA is free, version-controlled, has no 30s cap, needs no console automation, and never exposes a secret in a DOM. Net: fewer moving parts and fewer auth gotchas, reviewable in git.

### 9. Spent one-off scheduled tasks linger. [Trevor]
`verify-sales-backstop-schedule` (disabled, already fired) and similar one-offs accumulate (only Trevor can delete them). The hygiene report already flags these — just act on the list periodically.

---

## Deliberately NOT recommended
- **More scheduled tasks.** 23 is already dense; the leverage is consolidation, not addition.
- **New artifacts for their own sake.** 14 live; surface-QA already owns their freshness.
- The wins are in (a) making recurring judgment calls deterministic and (b) shrinking what every session loads.

---

## Suggested execution order
1. **[now]** MEMORY.md index trim (it's degrading this session).
2. **[SKILL]** Time-anchor preamble + focus.md pruning + ledger/handoff roll tightening into the three task SKILL.mds (one editing pass).
3. **[CC]** schema-truth generator into the data-quality sweep; finish cron→GHA pt2.
4. **[SKILL]** post-ship-watch checklist.
