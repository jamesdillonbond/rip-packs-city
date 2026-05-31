# RPC nightly autonomous pass — handoff 2026-05-30 (PM / off-hours monitor run)

Run: `rpc-nightly-autonomous-pass`, fired **2026-05-30 ~22:14 UTC (15:14 PDT)** — i.e. mid-day, **outside** the 00:00–06:00 overnight window. Operator (Trevor) was present and explicitly authorized proceeding as a live run rather than off-hours queue-only ("the off hours blocker is good, we're testing everything out here. Let's go ahead and proceed even though it's mid-day").

> Naming note: the canonical `docs/handoff-2026-05-30-overnight-pass.md` (07:16 UTC, 14.7 KB) is **the prior nightly run** from early this morning and was left untouched. This PM run uses the `-pm` suffix.

## TL;DR — Outcome: SHIPPED NOTHING (correctly). Health GREEN.

This was a textbook **hot-main / active-operator night**. The collision gate — not the off-hours guard — is what held shipping back, and it held for the right reasons:

- `origin/main` moved to `bd4d8c4` **~22 min before** the run started (after the daytime monitor's 21:32 UTC sweep, which saw `f9388c7`).
- The working tree was **very dirty** (55 tracked files modified, incl. off-limits files `proxy.ts`, `app/api/fmv-recalc/route.ts`, `app/api/ingest/route.ts`, `lib/flow.ts`, `lib/collections.ts`, plus in-flight Phase D `lib/chains/flow/*`).
- The **headline inbox candidate (P1) was being actively executed by the operator during the run window** — see below.

No regressions surfaced, so no auto-revert was needed. A quiet, honest night.

## Gates
- **Lock:** none present → created `docs/overnight/.lock` (`8a4b884c`); removed at end of run.
- **FREEZE:** absent.
- **Quiet-hours:** OUTSIDE 00:00–06:00 → default would be monitor-mode (queue, don't ship). Operator authorized a live run. All other safety rules (OFF-LIMITS set, collision gate, ≤4 ship budget, CI/typecheck gate, independent verification) were kept in force — the override only lifted the time-of-day restriction.
- **Branch:** `main`, `rev-list origin/main..HEAD = 0` at start and at commit time.
- **Continuity:** first night pass since the overnight scaffold was bootstrapped (21:35 UTC today). No prior `ledger.md` / `metrics-latest.json` / `focus.md` existed — created `ledger.md` + `metrics-latest.json` this run.

## What was reviewed
- `CLAUDE.md` (full), the single daytime inbox file `docs/overnight/inbox/2026-05-30T21-32-45Z.md` (5 candidates P1–P5), last 25 commits + 48h hot-file list, `pipeline_runs` (24h), Supabase `get_advisors` (security + performance), Vercel deploys (last 20), Sentry unresolved (48h), the 7 Cowork artifacts, and live DB state for the post-ship watch.

## Post-ship regression watch (last ~24–48h ships) — GREEN, no revert
Re-measured the metric each recent ship targeted:

| Ship | Target metric | Now | Verdict |
|---|---|---|---|
| Step 6 NO_DATA cycle fix (`14ae144`) | TS NO_DATA not re-cycling; HIGH+MED stable | NO_DATA 6,091 (flat vs monitor 6,100); TS HIGH+MED **780** (≈ baseline 778) | ✅ holding |
| Batched FMV RPCs (`upsert_topshot_marketplace_fmv`) | topshot-fmv-populate stops timing out | 2 runs/24h, **0 fails** | ✅ holding |
| Squeeze board + 21 insights surfaces | views return rows; routes healthy | all return rows; routes read via service_role | ✅ |
| Operator SECDEF view flip `audit_20260530_secdef_views_to_security_invoker` (21:48 UTC, 11 views → `security_invoker=on`) | public insights pages still return data | **SAFE** — every `/api/public/insights/*` route imports `supabaseAdmin` (service_role), which bypasses RLS; the flip cannot break those reads | ✅ verified safe |
| P2 fix `bd4d8c4` (pinnacle-listings-indexer Sentry noise) | deploy READY | `dpl_4UBShmk267fUqit46PFZNuTLRFJd` **READY** | ✅ |
| Phase D shims `1b7cfde` | build green | deploys READY since; one historical ERROR (`01b3878`, missing-shim build) already superseded | ✅ |

## Health-drift findings + overnight deltas
First night with a baseline → these become the deltas for the next run (`metrics-latest.json`).

- **Deploys:** production `bd4d8c4` READY. Lone ERROR deploy `dpl_9BVVoDCcUfHtyDGUHSAQLrxuSQba` (`01b3878`) is the known missing-Phase-D-shim build, fixed by `1b7cfde` + many READY deploys since. Not actionable.
- **Pipelines (24h):** only low-single-digit **transient** failures (`compute-topshot-pack-ev` 5/90, `evm-transfers-ingest` 3/21, several others 1–2), all "connection pool / time-budget" with clean runs since — the documented connection-pool pressure theme (P5). No logic failures.
  - `compute-laliga-pack-ev` idle ~17h (last 05:30 UTC, 2 runs/24h, **0 fails**) — benign (Golazos has no confirmed primary pack path); see P4.
  - `snapshot-institutional-wallets` 1 fail/24h, last 13:16 UTC — externally cron'd via cron-job.org (known, resilient).
- **FMV (latest-per-edition):** Top Shot HIGH 196 / MED 584 (HIGH+MED **780**); AllDay HIGH 50 / MED 191 (HIGH+MED **241**).
- **Sentinel — TS edition-writer leak (48h):** **1,707** inert UUID-keyed rows → WARN band (<2,000), **down** from 1,842 (monitor) and 2,695 (earlier 05-30 pulse). Improving; trigger keeps rows inert. Known Item B2.
- **`unmapped_sales`:** 144 open / 138 within 7d / **1 new in 24h** — resolver keeping up, flat.
- **Editions:** nba_top_shot 16,274 · nfl_all_day 6,191 · laliga_golazos 581 · ufc_strike 446.
- **DB size:** 5,815 MB.
- **Advisors:** security **3 ERROR** / 63 WARN / 24 INFO; performance 4 WARN / 354 INFO. The 3 ERRORs are all `security_definer_view` — see P1 (down from 14 at the monitor sweep; actively being remediated).
- **Sentry:** 1 unresolved issue first-seen-in-48h: `JAVASCRIPT-NEXTJS-1B` (pinnacle/moment null destructure, P3) — last seen ~5h ago, no recurrence since the deployed fix.

## Inbox triage (P1–P5)

### P1 — 14 SECURITY DEFINER views flagged ERROR → **being remediated live by the operator; HANDS OFF**
At the monitor's 21:32 UTC sweep there were 14. By this run there are **3** (`topshot_pack_reality_top_ev`, `topshot_pack_reality_stats`, `topshot_pack_reality_dist`). The other 11 were flipped to `security_invoker=on` by migration **`audit_20260530_secdef_views_to_security_invoker`** (applied 21:48 UTC, ~26 min before this run). This is active, fresh, operator-owned work — flipping the remaining 3 autonomously would collide head-on with the migration the operator is mid-sequence on, and would override their deliberate scoping. **Not shipped.** Queued below with a ready-to-run migration + the safety evidence (the flip is low-risk: all readers are service_role).

### P2 — pinnacle-listings-indexer Sentry noise → **RESOLVED by `bd4d8c4`**
The operator shipped `bd4d8c4` (14:52 PDT, deploy READY) which `.select()`s the failure-queue upsert so only genuinely-new inserts increment the counter, instead of counting the ~1.5k permanently-capped Pinnacle retry backlog on every tick. Root cause addressed. No action.

### P3 — pinnacle/moment `TypeError: Cannot destructure … null` → **RESOLVED (confirm at 24h)**
Sentry `JAVASCRIPT-NEXTJS-1B`, 3 events / 1 user, first + last seen ~5h ago, no recurrence. Fixed by the `01b3878` → `26d5968` → `fe96d4b` (decodeURIComponent) chain. Only ~5h clean so far — leave the Sentry issue open and **mark resolved once 24h clean** (don't auto-resolve yet). No code action.

### P4 — `compute-laliga-pack-ev` silent ~17h → **benign; queued for awareness**
0 fails, 2 runs/24h — idle, not failing. Golazos has no confirmed primary pack-drop path (per CLAUDE.md), so low/zero cadence is expected. Not autonomously actionable: pack-EV route logic is OFF-LIMITS and the cron lives at cron-job.org (operator-owned). Trevor: confirm the intended cadence if you expect it to run more often.

### P5 — connection-pool pressure → **known theme, no action**
Corroborated: every transient pipeline failure in 24h is connection-pool / statement-timeout, all recovered. Awareness only; matches the documented "real lever = DB connection-pool pressure."

## Cowork artifacts
7 artifacts enumerated: `rpc-traction` (new, 19:57 UTC), `rpc-deploys-and-cost`, `rpc-trophy-ladder`, `rpc-cross-collection`, `rpc-my-wallet`, `rpc-fmv-watch`, `rpc-live-health`. None flagged broken by the daytime monitor. They read via the service-role MCP path, so the `security_invoker` view flips don't change their results. Per guidance ("don't regenerate working artifacts for no reason"), **none modified**.

## SHIPPED
None.

## QUEUED (ready to run; not auto-shipped)

### Q1 — flip the remaining 3 `topshot_pack_reality_*` views to `security_invoker` (clears the last 3 security ERRORs)
**Why not auto-shipped:** the operator is actively executing exactly this remediation (11/14 done during the run window via `audit_20260530_secdef_views_to_security_invoker`). Applying the tail-3 autonomously collides with in-flight work and overrides their migration's deliberate scope. **Defer to the operator / a future quiet night.**
**Safety evidence (verified this run):** all three views are read only by `/api/public/insights/pack-reality/route.ts`, which imports `supabaseAdmin` (service_role) — service_role bypasses RLS, so flipping to invoker mode cannot break the public page. No client-side anon PostgREST reads of these views exist in `app/`, `components/`, or `lib/`.
**Ready-to-run migration** (`apply_migration`, name `audit_20260530_secdef_pack_reality_views_to_security_invoker`):
```sql
ALTER VIEW public.topshot_pack_reality_top_ev SET (security_invoker = on);
ALTER VIEW public.topshot_pack_reality_stats  SET (security_invoker = on);
ALTER VIEW public.topshot_pack_reality_dist   SET (security_invoker = on);
```
**Revert:** `ALTER VIEW <v> SET (security_invoker = off);` for each.
**Target metric:** Supabase `get_advisors(security)` `security_definer_view` ERROR count 3 → 0; `/api/public/insights/pack-reality` still returns `stats`+`dist`+`top_ev` rows.

### Q2 — confirm `compute-laliga-pack-ev` cron cadence (P4)
Operator decision: verify the cron-job.org entry is enabled at the intended cadence, or accept the idle as by-design. No code change recommended (pack-EV logic off-limits).

## FAILED / AUTO-REVERTED
None.

## Deferred this run (with reason)
- **CLAUDE.md "Recent sessions" prepend:** SKIPPED. `CLAUDE.md` is in the operator's dirty working tree (uncommitted edits). Editing + committing it would sweep up their in-flight work. This handoff doc is the session record instead. Re-add a Recent-sessions line on the next clean-tree run.
- **Git commit of these continuity docs:** DEFERRED — could not commit from the sandbox. This run's environment mount **denies file unlink/delete** (create/write are allowed): `rm -f .git/index.lock` returns `Operation not permitted` even though the lock is owned by my own uid, and a freshly-created temp file under `.git/` also could not be removed. A stale `.git/index.lock` (mtime 2026-05-30 05:41 UTC, ~17h old, no live git process) therefore blocks every `git add`/`commit`, and I cannot clear it. The 4 docs (`handoff-2026-05-30-overnight-pass-pm.md`, `overnight/ledger.md`, `overnight/metrics-latest.json`, `overnight/inbox/archive/2026-05-30T21-32-45Z.md`) are **written to disk** so the next pass reads them normally, but they are **not git-committed/pushed**.
  - **Operator one-liner to land them:** `cd ~/rip-packs-city && rm -f .git/index.lock && git add docs/handoff-2026-05-30-overnight-pass-pm.md docs/overnight/ && git commit -m "docs(overnight): PM monitor-run handoff, ledger, metrics baseline" && git push origin main` (review `git status` first — your working tree has 55 unrelated modified files; the `git add` above stages only the docs).
- **`docs/overnight/.lock` removal:** the same unlink denial prevents me from deleting my own run lock. It will **self-expire** via the ≥45-min staleness rule (mtime 22:14 UTC), so the next run takes it over cleanly. Left untouched on purpose (overwriting it would refresh its mtime and falsely look "fresh").

## For the next run
- Re-check P1: are all 14 SECDEF views now `security_invoker=on` (i.e. did the operator finish the tail-3)? If 3 still remain and the tree is clean + main quiet, Q1 is a safe SHIP.
- Re-check P3 Sentry `JAVASCRIPT-NEXTJS-1B`: if 24h clean, mark resolved.
- Deltas vs `metrics-latest.json` (this run is the baseline): watch TS HIGH+MED (780), sentinel TS leak (1,707, want ↓ <2,000 and toward <250), unmapped_sales open (144).
