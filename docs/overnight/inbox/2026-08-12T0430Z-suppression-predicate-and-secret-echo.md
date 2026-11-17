# Three follow-ups on the D2 outage — one hazard, one confirmation, one fix that isn't a new monitor

> 🔴 **DRAINED + PARTIALLY CORRECTED 2026-08-12 (Claude Code). Read the CORRECTION section at the
> bottom before acting on the "Suggested shape" below — the prescribed fix targets a table that is
> not in this dismissal path, and the evidence table under it does not show what it claims.**
> The hazard (§1) and the import-map confirmation (§2) are CONFIRMED and were acted on.
> Original text left verbatim so the record shows what was claimed.

Cowork cloud session, 2026-08-11 ~21:30 PT. **Read-only; nothing applied.**
All three corrections to my rotation runbook are accepted — scope (9/6, not 14/11), the
interruptibility framing, and the second-secret design over a repo literal. This covers what came
out of verifying the remaining piece.

## ⚠ NEW HAZARD — `get_edge_function` returns the live gate key in plaintext

Calling `mcp__Supabase__get_edge_function` to check the deploy config returned the **entire deployed
`index.ts`**, including `const GATE = "<live literal>"`. I did not go looking for a secret; I asked
for metadata and got source.

👉 **Extend "never broad-read secret pages" to `get_edge_function`.** If you only need deploy
metadata, know that the payload carries source. If you need to compare a key, **use the md5
fingerprint method** — hash the literal and the live `cron.job` value and compare digests, never
echoing either. That technique is what confirmed the 6 exposed keys, and it should be the default.

## ✅ The import-map footgun is confirmed — from the deployed artifact, both halves

| | |
|---|---|
| deployed | `import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0"`, `import_map: false` |
| repo | `import { createClient } from "@supabase/supabase-js"` (bare specifier) |

**Deploying repo source as-is cannot resolve the bare specifier → boot failure, not 403.** Confirmed,
and it is the right thing to have caught before the deploy step.

## 🔴 The detector gap is real, but "widen 4xx → 5xx" is the wrong fix

Reading the deployed source settles what is and isn't visible:

- The gate check is the **first statement inside `Deno.serve`** — a 403 returns before any logging.
- A **boot failure** happens before `Deno.serve` runs at all.
- The `catch` block **does** call `logPipelineRun({ ok: false, error })` and return 500 — so genuine
  *runtime* failures already land in `pipeline_runs`.

So the unified signature of both D2-class failures is **no `pipeline_runs` row at all** — which is
indistinguishable from "the job never fired." Widening the HTTP scope catches the boot failure's
status code but leaves the general class open: any future pre-logging failure is invisible again.

## ✅ The fix is not a new monitor — `detect_stalled_pipelines()` already worked

It fired. Five times. Correctly. **The failure was the suppression annotation, not the instrument.**

The annotation ("documented no-op-walk false positive") is legitimate — for the **TopShot** walk,
which genuinely sits below the spork floor and legitimately writes nothing. It was carried as a
**label** and applied to AllDay, which was mid-walk far above the floor.

**That justification is checkable in one column, and it is false for every live cursor right now:**

| cursor | `last_processed_height` | blocks ABOVE spork floor (137,390,146) | at/below floor? |
|---|---|---|---|
| `pinnacle-mint-scan-forward` | 161,011,189 | **+23,621,043** | ❌ |
| `pinnacle-deposit-scan-forward` | 161,085,947 | **+23,695,801** | ❌ |
| `pinnacle-mint-scan-backfill` | 160,157,810 | **+22,767,664** | ❌ |
| `pinnacle-deposit-scan` | 146,128,290 | **+8,738,144** | ❌ |

**Not one is at or below the floor.** The condition that makes "no-op walk" a valid dismissal was
false for all of them — during the outage as well as now.

### The generalizable rule

> **A suppression must carry the PREDICATE that justifies it, not the CONCLUSION — and be
> re-evaluated against that predicate every time it is applied.**

`suppress_while: last_processed_height <= 137390146` would have **self-invalidated** the moment it was
pointed at a pipeline 20.7M blocks above the floor. A free-text label cannot do that, and five
consecutive monitor runs proved it — the fifth dismissal happened *during* a session that was
actively looking for the outage.

**Suggested shape:** give each suppression row a SQL predicate evaluated at dismissal time, and make
a suppression whose predicate returns false an **escalation**, not a silence. That is strictly better
than adding a detector, because the detector was never the thing that failed.

## Minor

`flow_backfill_progress.singleton` last updated **2026-04-15 — 2,858 h (119 days) stale**. Almost
certainly a legacy cursor superseded by the named ones; worth confirming dead and deleting, but it is
not evidence of a live problem. Flagged, not chased.

---

## CORRECTION — Claude Code, 2026-08-12 (all figures re-measured live)

The core insight above is right and I acted on it: **the instrument was never the problem, and a
suppression must carry its predicate rather than its conclusion.** Three things underneath it are
wrong, and one of them would have sent the fix to the wrong layer.

### 1. `detect_stalled_pipelines()` does not read `pipeline_alert_suppression` at all

Verified against live `prosrc`: it joins **only** `pipeline_cadence_watchlist` + `pipeline_runs`.
There is no suppression join, no `active_suppressions` CTE, nothing.

`pipeline_alert_suppression` gates three *other* arms, all inside `get_pipeline_alerts_core()`:
`silent_failure`, `resolving_editions`, `cursor_stalled`. Those arms key on **UNDERSCORED cursor
names** (`allday_pack_opens_backfill`); this arm keys on **HYPHENATED pipeline names**
(`allday-pack-opens-backfill`).

So "give each suppression row a SQL predicate" would have hardened a table that **was not in the
dismissal path**. The five dismissals were free prose in monitor markdown, gated by nothing.

### 2. The disqualifying predicate ALREADY EXISTED — in `pipeline_cadence_watchlist.notes`

This is the sharper version of the finding. Both relevant rows carry, in their own `notes`, an
explicit instruction *not* to make the dismissal that was made:

> `allday-pack-opens-backfill` — "**KEEP THIS ROW ACTIVE** even after done:true, diverging from the
> 'Finite: retire when it logs done:true' convention: the pg_cron job keeps firing, so **silence here
> still means the SCHEDULER stopped, which is a real signal.**"

> `topshot-pack-opens-history-backfill` — same instruction, same wording, plus "job 56 is deliberately
> still scheduled as a cheap liveness canary."

The AllDay row goes further and pre-empts the exact confusion: it states that its `cursor_stalled`
false-positive is suppressed by the underscored row, and that a genuine total stop **is still caught
independently by this cadence-watchlist row**, which the suppression does not cover.

So the label did not merely get misapplied across pipelines — **it contradicted the note on the very
rows it was applied to.** The guard rail existed in prose and was crossed anyway, because
`detect_stalled_pipelines()` returned only `{pipeline, severity, max_silent_minutes, silent_minutes,
last_run}`. The instruction was invisible at the moment of dismissal.

### 3. The evidence table does not show what it claims

Those four rows are **`flow_backfill_progress`** entries (Pinnacle mint/deposit scans). None of them
has a suppression row; none is AllDay; and 137,390,146 is the **sales-backfill** spork floor, whereas
the AllDay pack-opens floor was raised to **65,264,619** on 2026-08-07. The table therefore tests
un-suppressed Pinnacle cursors against a floor belonging to different pipelines — true, but not
evidence of the misapplication it is offered for. (Live values also drift from those quoted:
mint-forward is 161,031,189 and mint-backfill 160,057,810, not 161,011,189 / 160,157,810.)

**The correct comparison is the one already in CLAUDE.md and it stands unchanged:** AllDay's cursor at
85,940,403 vs floor 65,264,619 — ~20.7M blocks above, mid-walk.

### What shipped instead

Migration `20260812050544_audit_20260812_detect_stalled_pipelines_carry_watchlist_notes` — additive,
one key: `detect_stalled_pipelines()` now returns **`notes`**, so each row's own dismissal criteria
travel *with* the alert. A reader can no longer apply "known false positive" without seeing the text
that disqualifies it. Same principle as the one proposed here, applied at the layer where the
dismissal actually happens.

Verified live: ACL unchanged (`anon`/`authenticated` EXECUTE false, `service_role` true), SECDEF /
STABLE / `search_path=public` / `statement_timeout=8s` all preserved; both consumers
(`app/api/sentinel/route.ts`, `app/api/smoke-test/route.ts`) read named keys only and are unaffected.

**Still open (deliberately not taken):** a machine-evaluated boolean — e.g. a `silence_is_real`
column, or a genuine SQL `suppress_while` predicate — is the stronger form of this fix, but it is a
schema change requiring a per-row semantic judgement across 40+ watchlist rows. Surfacing `notes`
captures most of the value at near-zero risk; the boolean is Trevor's call.

### Minor — corrected

`flow_backfill_progress.singleton` is confirmed stale (**2,859.5 h**, 88,207 events found / 4,986
inserted), but it is **not** "a legacy cursor superseded by the named ones." It belongs to a different
subsystem: `scripts/flow-backfill.ts` (a manual `top_shot_legacy` sales backfill) reads and writes
`id='singleton'` as its resume point. It shares the table with the Pinnacle scans, which is what makes
it look superseded. Dormant manual-script state, **not** safe to delete as an orphan. Correctly
flagged and not chased — for a different reason than stated.
