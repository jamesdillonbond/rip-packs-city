# Claude Code → Cowork: evening-pass hand-off — 2 held DELETEs (one due 4 PM PT today), 1 firewall read, 1 DROP, 2 cron-job.org changes awaiting Trevor's go, 3 dated reads

**Filed 2026-11-23 ~7:45 AM PT by Claude Code cloud** at the end of the 12-hour evening autonomous pass
(11-22 ~7:30 PM → 11-23 ~7:20 AM PT). Trevor: "Hand it off to cowork".

**Why Cowork:** each item needs one of these, and this cloud session has none of them:
- Trevor's Chrome: the Supabase SQL editor, the Vercel firewall dashboard, the cron-job.org console.
- An attended session where the Supabase MCP confirmation dialog can be answered. It never reached Trevor here: `apply_migration` timed out on a confirm prompt four times tonight. Each time I verified nothing reached Postgres.

Full context: [handoff-2026-11-22-evening-autonomous-pass.md](../../handoff-2026-11-22-evening-autonomous-pass.md); ledger 11-22 ~8 PM → 11-23 ~7:20 AM PT.

**State at filing (MCP read, 7:43 AM PT):**
- Bridge rows left: 2.
- Stale suppression rows left: 1.
- `check_set_completion(text)` exists, with 0 pg_cron references.

---

## 1. ⏰ DUE BEFORE 4:00 PM PT TODAY — retire two cadence bridges (held DELETE)

Steps, premise and verify are in **item 2** of [2026-11-23T0200Z-…-held-delete-stale-challenges-suppression.md](2026-11-23T0200Z-claude-code-for-cowork-held-delete-stale-challenges-suppression.md).

**What:** the `cadence_exempt_lanes` rows `pack-pulls-chain-history` and `pinnacle-pack-openers`.

**Why:**
- Their `review_by` is 11-23. When the DB date rolls at 4 PM PT, the sentinel cadence arm floors at WARN for a review that is already done.
- Re-measured ~4 AM PT: both lanes run at ratio **1.000** against the 11-24 baseline (120/120 and 144/144 runs a day; the arm trips at 0.40).

**Run it in:** the SQL editor, or `apply_migration` named `audit_20261122_retire_two_cadence_bridges_whose_baseline_is_clean` in an attended session.

**If it lands after 4 PM:** the same delete clears the WARN.

## 2. Drop the stale `ingest-topshot-challenges` suppression (held DELETE)

Steps are in **item 1** of the same filing.

**Why:** the suppression's "Redundant, not broken … 0 rows" claim is false.
- The lane wrote 1,029 rows in 7 d via pg_cron 771/772.
- While the row exists, that lane's failure alerts are silenced until 12-04.

## 3. #235 firewall read (read-only, Vercel dashboard in Trevor's Chrome)

**What happened:** a **17-region** sweep hit **~450–500+ invocations/min on 11-16 10:10–10:14 PM PT** (06:10–06:14Z 11-17). Regions included gru1 637, sfo1 541, sin1 316, fra1 228, bom1 183 and arn1 115.

**What to read:** whether the `Entity page sweep` rule (`rule_entity_page_sweep_eNQlGa`, JA4 key) **logged** that window or **rate-limited** it. The MCP's `get_firewall_config` 404s, so the dashboard is the only instrument.

**What to record:**
- If it only logged: that is the Log → Rate Limit decision for Trevor.
- Record the answer in known-issues #235, which has the full week read.
- ⚠ The exit "no minute > 400" counts our own QA sweeps (1–3 US regions, up to 1,346/min last night). Read it as **"no minute > 400 through ≥ 10 regions"**.

## 4. DROP `public.check_set_completion(text)` (attended)

**Why:**
- Zero callers: code, SQL bodies, pg_cron, cron-job.org and pg_stat_statements all checked 11-22.
- It is the only live function that joins `editions.external_id` to an edition key **without a collection scope** (the CLAUDE.md #142 class). It is wrong-if-ever-called and dead.

**Steps:**
1. Re-read callers: `grep -rn check_set_completion app lib scripts supabase/functions` (non-migration refs must be 0), and `select count(*) from cron.job where command ilike '%check_set_completion%'` (must be 0).
2. `pg_get_functiondef` it into the migration file as the revert path, then `DROP FUNCTION public.check_set_completion(text);` via `apply_migration` (attended) or the SQL editor.
3. Clean up after the DROP:
   - Remove any `supabase/tests/*.sql` pin and its drift-guard entry for it (`grep -rln check_set_completion supabase/tests __tests__`).
   - `npm run preflight`.

## 5. Two cron-job.org changes — **ask Trevor first** (his calls, not yet decided)

1. **`topshot-sales-indexer` interval.**
   - The case for shortening: it is the remaining drop-day lever now that the fmv hot lane is fixed (Top Shot sale-ingest lag p50 16 min / p90 53 min).
   - Recommendation: a shorter interval if the console allows. Trevor decides.
2. **Pause `topshot-buyer-backfill-historical`** (every 30 min).
   - It has re-found the same one undecodable row (`decode_404`, `spork_floor`) on every run since 08-28, with 0 written.
   - Recommendation: pause. Trevor decides.

## 6. Dated reads

| when | read | expect |
|---|---|---|
| **~5:10 PM PT 11-23** | Sentinel "Panini Ingest" unrecognised-key WARN | clears as the 11-22 5:09 PM PT drops leave the 24 h window. Per-run `extra.sales_history_unrecognised_keys` has been 0 across 2,330 runs since the `20261123045852` fix. |
| **11-24** | fmv-recalc `:08` `extra.historical_fallback_error` rate, full day | early read 1/16 = 6.3 % (was 21 % before job 704 moved off minute 9). Still ≥ 10 % → the collision is not job 704 alone. |
| **Mon 11-30 ~3:45 AM PT** | Top Shot gate **week 3**: `fmv_accuracy_weekly` week_start 2026-11-23, `sum(within_25_pct*n)/sum(n)` by confidence | HIGH and MEDIUM each ≥ 70 (weeks 1–2: 80.1/74.1, **83.3/73.1**). ⚠ `within_25_pct` is already a percentage — do not ×100. Write the result into `go-live-2026-09.md` §6 item 5. |

## Already verified tonight — nothing owed

- Job 704 (`pack-rips-chain-rekey`): −50 % (14.3 s vs 28.5 s), with cursor windows contiguous.
- fmv hot lane: 0 stranded.
- Job 850 (eligible refresh): 26.6 s vs 92.5 s.
- Candy profile breakdown: live, 575 moments / $474.49.
- Weekly email data pre-send: 39 blocks, 19 correctly omitted, 0 NULL.
- `wallet_held_pack_value`: 0 errors in 48 h (the overnight carry was stale; marked resolved).
- CI green; prod READY `245f4cb1`.
