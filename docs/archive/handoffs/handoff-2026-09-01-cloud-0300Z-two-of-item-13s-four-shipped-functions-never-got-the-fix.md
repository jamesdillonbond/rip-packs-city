# Handoff — 2026-09-01 cloud 0300Z — two of item 13's four "shipped" functions never got that fix, and the UFC FMV preload now has its RPC

> ## ✅ DRAINED 2026-08-31 ~21:1x PT by Claude Code (Trevor's Windows box, push-capable)
>
> Every "queued for Claude Code" item below is now closed. **One was NOT done as queued** — the
> `edition_fmv_current` swap was measured unsafe and a LATERAL shipped instead; see
> **§ Drain outcome** at the bottom, and
> `inbox/2026-09-01T0400Z-edition-fmv-current-is-not-substitutable-in-fmv-recalc-and-the-lateral-is.md`.
> The full record is in the ledger entry dated **2026-08-31**.

**Pass:** cloud-only autonomous pass, fired **2026-09-01 02:58:31Z = 2026-08-31 19:58 PT**.
**DB `now()` in-query** `02:58:50Z` vs container `02:58:31Z` — agree to ~19 s, **fifth consecutive pass
with no skew**. **Repo read:** fresh clone of `origin/main` at **`7c63fa3`**, no commit on main in ~19.4 h.

> ⚠ The NO-PUSH blocker below was specific to that cloud session. Trevor's machine and Claude Code push
> normally via the PAT in `remote.origin.pushurl`.

| capability | result |
|---|---|
| `git clone origin/main` (read) | ✅ |
| push | ⛔ 403 *"not in this session's authorized repository set"* — operator-only |
| `mcp__remote-devices__*` | ⛔ **ABSENT ENTIRELY** — the device-bridged parity sweep could not run; parity was derived by hand |
| Supabase MCP | ✅ | 
| Vercel MCP | ✅ with `teamId` (the slug still 403s) |
| Sentry | ⚠ not consulted — quota exhausted since 08-18, so zero issues is **DARK, not clean** |

## HEALTH VERDICT: 🟢 GREEN

`detect_stalled_pipelines()` `[]` · `check_secdef_anon_execute_violations()` `[]` (the **VALUE**, not
`count(*)`) · 38 trust arms, **2 BREACH** — `public_board_slow_count` **1** (6 → 1 since 0219Z) and
`unmapped_resolution_backlog_max` **228** (265 → 255 → 228; ⛔ do not raise either `breach_at`) ·
`trust_precompute_max_age_hours` 5.2 vs 13 · pg_cron **1,985 succeeded / 0 failed** over 12 h · 102 jobs,
0 `tmp-idx%` leftovers · Vercel prod 180 min: **4 × 502, 0 × 500, 0 × 504** of **3,051**, all four 502s
distinct `/api/public/ipfs-media/<cid>` (known upstream IPFS class). The 01:00Z pass's 103 × 502 / 4 × 500
has now failed to reproduce in two consecutive 180-minute windows.

### ⚠ NEW INSTRUMENT GOTCHA — `v_rpc_trust_health` has NO `is_breach` column, and asking for one reads CLEAN

`public.get_trust_health()` does not exist. The board is the view `public.v_rpc_trust_health`
`(metric, value, breach_at, status, catches)`. This pass's first read filtered on
`(to_jsonb(t)->>'is_breach')::boolean` and returned **`[]` — a false all-clear over two real breaches** —
because the missing key is NULL and the filter drops every row. Correct predicate:
`upper(status) <> 'OK'` (values are case-mixed: `ok` / `BREACH`). Same family as `count(*)` on
`check_secdef_anon_execute_violations()` reading 1 when clean.
ⓘ **It also costs ~280,000–350,000 buffers per SELECT** (352,591 / 336,813 / 279,358, measured three
times in this pass's own pgss diff). **Read the board once per pass and reuse the row set.**
✅ *Written up by the drain in `docs/reference/tooling-gotchas.md`.*

## ⛔ DEAD-HOST PROBE (thread #11) — STILL DEAD

`POST public-api.nbatopshot.com/graphql` at 02:59Z → **530, 530**. Positive control
`rest-mainnet.onflow.org/v1/blocks?height=sealed` → **200** from the same shell in the same second.
**Exit NOT met** (needs non-5xx twice). Nothing re-enabled. **Sixth consecutive pass recording 530.**

## ✅ SHIPPED — migration `20260901030456`

`public.get_fmv_snapshot_for_editions(p_collection_id uuid, p_edition_ids uuid[])` →
`TABLE(edition_id uuid, fmv_usd numeric, confidence public.fmv_confidence, sales_count_30d integer)`.

**Why.** `enrich-ufc-wallet/index.ts:171-189` preloaded the whole UFC catalogue in 200-wide PostgREST
slices at **~185,457 buffers / ~29.4 s per call** against the 30 s `service_role` cap, three calls per
invocation, 264–265 invocations a day. The plan is a walk of the **ordering** index
`idx_fmv_snapshots_2026_computed_at_desc` with `edition_id` as a Filter, accumulating toward PostgREST's
1,000-row cap that a ~200-edition slice can never reach.

⛔ The straight swap to `get_fmv_for_editions` does not typecheck — it returns `(edition_id, fmv_usd)`
only, and the caller needs `confidence` and `sales_count_30d` for its $10K ceiling at `index.ts:196-200`.
**Verified in the source, not taken from the handoff.**

**Measured THROUGH the function:** all 518 UFC editions in ONE call = **4,195 buffers / 196 ms / 381 rows**
(232 of those buffers are the scratch query that built the id array), against **~556,371 buffers** for
today's three slices — **~140×**.

⭐ **The durable claim is structural, not a ratio.** The `LIMIT 1` lives **inside** the LATERAL, so this
can only ever do one index descent per `edition_id`. The ordering-index walk is not out-costed, it is
**unreachable**. That matters because 0219Z established it could *observe* production's plan choice but
not *reproduce* it.

**EQUIVALENCE — three ways on a real 200-edition slice:** 142 rows from the new function; 142 from an
independent `DISTINCT ON (edition_id) … ORDER BY edition_id, computed_at DESC` reference; `EXCEPT`
**0 / 0** both directions; and its shared `(edition_id, fmv_usd)` columns are `EXCEPT`-identical both ways
to the live `get_fmv_for_editions`.

**SECURITY.** A new signature lands with default PUBLIC EXECUTE, so it was explicitly closed. Verified
from the catalog after applying: `service_role` + `postgres` only, `has_function_privilege` **false** for
both `anon` and `authenticated`, not SECURITY DEFINER, violations `[]` after the ship.

**EXIT:** once the caller lands, one call over all 518 editions should read **< 12,000 buffers** and pgss
queryid `1387451210050502049` should leave the top-15 diff. Over 30,000 ⇒ the LATERAL stopped using
`fmv_snapshots_2026_edition_id_computed_at_conf_idx`; check `last_autovacuum` before touching SQL.
**FALSIFIER:** 0 calls a week after the caller ships ⇒ the caller change did not land — do not assume it
did. **⚠ CAP:** PostgREST `db-max-rows=1000` applies to RPC results; UFC's 518 cannot approach it, but a
collection with >1,000 priced editions **must** keep chunking.
**REVERT:** `DROP FUNCTION IF EXISTS public.get_fmv_snapshot_for_editions(uuid, uuid[]);`

## ⭐ CORRECTION — open thread #13 names FOUR functions as having shipped the `plan_cache_mode` fix. The catalog says TWO.

| function | language | has `plan_cache_mode` |
|---|---|---|
| `get_wallet_moments_with_fmv` | plpgsql | ✅ |
| `get_wallet_total_fmv` | plpgsql | ✅ |
| **`get_fmv_for_editions`** | **sql** | **❌** |
| **`get_pack_realized_ev_row`** | **sql** | **❌** |
| (`get_acquisition_stats`) | sql | ❌ |

**Not a missing ship — a conflation of two remedies from the same night.** `20260830030332` is a
**LATERAL rewrite**; `20260830032541` a **predicate pushdown**. #13's quoted post-ship numbers for those
two (17.8 ms / 26 reads; 283 ms / 246 reads) measure *those* fixes.

⛔ **The correct action is NO ACTION.** Both are now key-lookup shapes whose plan does not turn on
parameter *values*, and the ledger already records a controlled test where `force_custom_plan` made **no
difference** (*"#52's remedy does not generalise to this function"*). The harm prevented is a future pass
"verifying" a fix that was never applied, finding it absent, and re-applying a remedy already measured
inert. ✅ *Recorded by the drain in **known-issues #52**, the register item that governs the class, rather
than only in the per-run `metrics-latest.json` which the next run overwrites.*

## POST-SHIP WATCH on the 0219Z index (`20260901023633`)

**FALSIFIER NOT MET, decisively.** `fmv_snapshots_2026_edition_id_computed_at_conf_idx` (65 MB) has
**`idx_scan` 148,446** and `idx_tup_read` 9,748,274 in ~25 minutes, and it serves this pass's own
new-function plan.

⚠ **The `<150,000 buffers` half is NOT cleanly measurable, and I am saying so rather than reporting the
number that flatters it.** pgss queryid `-2504733205258152844` is `public.query_sql`, a **shared** hatch
used by both fmv-recalc and the Cowork MCP, so per-call buffers blend two populations: 524,913 / 506,492 /
**262,904** / 512,321 / 512,633 / 558,660 / **282,724** across the last seven windows. The post-ship
window halved — **but 23:13Z read 262,904 with no index at all.** The `idx_scan` is the evidence; the
blended figure is not an instrument.

**QUEUED, unchanged:** `fmv_snapshots_2026_edition_id_computed_at_idx` (64 MB) is a strict subset of the
new index but still carries 305,323,752 scans — deliberately not dropped.

## SATURATION DIFF (thread #15)

Snapshot `2026-09-01 03:00:37.931882+00`, baseline `02:20:07.871238+00` — a real **40.5-minute** window,
checked rather than assumed. Top of the diff by Δ(hit+read):

| Δbuffers | Δcalls | what |
|---:|---:|---|
| 6,785,393 | 24 | `public.query_sql` — fmv-recalc 5c/5d/5e + the MCP channel |
| 1,447,137 | 2 | ⚠ **the 0219Z pass's own A/B `EXPLAIN`** — the instrument, not a workload |
| 1,268,710 | 165 | `UPDATE wallet_moments_cache SET lock_checked_at` — **7,689 buffers per single-row update** |
| 1,079,152 | 1 | `run_refresh_pack_grail_metrics_mv_job()` |
| 790,939 | 1 | `analytics_smoke_run()` |
| 750,594 | 1 | `sync_allday_pack_dist_totals()` |
| 528,422 | 8 | `refresh_wmc_fmv_changed` |
| 364,738 | 8 | `refresh_wmc_fmv_drift_active` — **126,670 ms**, 257,719 disk reads |
| ~969,000 | 3 | ⚠ **`v_rpc_trust_health`, read three times across two passes** |

⛔ **Not taken as levers, each for a recorded reason:** both `refresh_wmc_fmv_*` are already owned (#36;
the 08-31 entry records the drift sweep as *"NOT a defect — duty-cycle-limited, and winning"*), and the
`lock_checked_at` cost is already explained in
`20260809010000_audit_20260809_allday_lock_picker_skipscan.sql`.

⚠ **Two of the top nine lines are the measurement apparatus itself** (~2.4 M buffers of a 40-minute
window). Third pass to say so; it belongs in Trevor's snapshot-scheduling decision, not in another finding.

## MIGRATION PARITY

Derived by hand (no device bridge) against `git ls-tree -r HEAD supabase/migrations` on `7c63fa3` —
**9 missing by name**, `check-migration-parity` **exiting 1**. Three same-window controls each matched
exactly one committed file, so the check is sound.
✅ *All 9 recovered and committed by the drain — see below.*

## 🚨 STILL FOR TREVOR — both scheduled tasks remain UNBOUND, and this firing was the duplicate's

Fired at 02:58:31Z = `trig_01AZzLzkTPp5xbSjK1EFmeCw`'s `58 */2 * * *` slot — the **superseded duplicate**,
whose prompt asserts *"✅ THIS TASK IS DEVICE-BOUND AND CAN PUSH"*. No `mcp__remote-devices__*` tool was
present, so it is not bound. **Falsified on five consecutive firings across both tasks.**

Retiring the duplicate is **Trevor's click alone**: `delete_trigger` and `update_trigger {enabled:false}`
both return *"MCP tool call requires approval"* in a scheduled run. No pass time was spent re-testing.
👉 A binding cannot be added to an existing task. Before creating a v3, **check in the desktop app on
`laptop-e3bdp9vs` that the card actually offers a device binding** — do not trust the label on the task.

---

# § Drain outcome — 2026-08-31 ~21:1x PT, Claude Code, Trevor's box

**All four queued items closed. Full suite green (1,417 files / 15,624 tests, real exit 0);
`npx tsc --noEmit` clean.**

1. **The 9 stranded migrations — COMMITTED, recovered not retyped.** `recover-fileless-migrations.mjs
   --window 3` wrote all 9 byte-exact from prod, script-verified md5; parity flipped
   `[MISSING] → [UNTRACKED]`. Cross-checked `20260901030456` = **`40591e25ae398d59fa061fa6dee3fce6`**,
   matching prod (the file carries no trailing newline, 4,970 bytes, so both digest forms coincide).

2. **`enrich-ufc-wallet` caller — SHIPPED**, chunked at **900** rather than one unbounded call, because
   PostgREST's `db-max-rows=1000` applies to RPC results and a silent truncation would look exactly like
   "these editions have no FMV". UFC's 518 is still a single call. Verified through the function first:
   381 rows / 381 distinct editions / 0 null fmv / 0 null confidence, so dropping the dedup loop is right.
   🚨 **A live honesty defect went out in the same lines:** the old read ignored `error`, and `fmvByExt`
   feeds `fmv_usd` on **every** `wallet_moments_cache` upsert — so a failed FMV read wrote `null` over the
   wallet's whole cached set, **a failed read acting as a DELETE**. It now throws.
   ⚠ **NOT YET DEPLOYED — see the deploy note below.**

3. **`cache-refresh` `lock_checked_at` — SHIPPED.** Ten single-row UPDATEs per batch → at most two,
   grouped by the value written. Also fixed `lockedBackfillCount` incrementing *before* the write.

4. **fmv-recalc Steps 5c/5d/5e — SHIPPED, BUT NOT AS QUEUED.** ⛔ The queued
   `edition_fmv_current` swap is **measured unsafe**: membership agrees perfectly (27,170 = 27,170, zero
   drift both ways) but `confidence` disagrees for **41** editions, and for **4** of those
   `edition_fmv_current` reads `NO_DATA` while the true latest snapshot does not — those 4 would have had a
   real snapshot **overwritten with an ASK_ONLY × 0.90 haircut**. Third independent time
   `edition_fmv_current` has been measured non-substitutable. A per-edition **LATERAL** shipped instead:
   **98,172 → 75,975 buffers, 452 → 159 ms** warm-vs-warm, equivalence proven **non-vacuously** over
   27,170 / 19,762 rows (`EXCEPT` 0/0 both directions). A `COALESCE(... ) = 'NO_DATA'` third variant was
   **falsified** at 120,508 buffers — worse than the original. Step 6's `latest` deliberately untouched.

**Monitors:** both daytime filings raised `topshot_impossible_parallel_serials` = 10. It reads **0 / ok**,
stamped **00:48:00Z — 36 minutes after the 00:06Z reading of 10**. Self-healed, no action owed. ⛔ The
0012Z filing's hypothesis (circ backfill blocked by the 530 dead host) is **FALSIFIED** — the host is
still 530 and the arm reconciled anyway. Both annotated in place with ✅ RESOLVED sections, **not
archived**, per the `inbox/` append-only rule.

## ⚠ ONE THING THE DRAIN DID NOT DO — the edge function is committed but NOT deployed

**A commit does not deploy a Supabase edge function.** Deployed `enrich-ufc-wallet` is **v46**, and
diffing it against the repo shows the repo is ahead by **more than tonight's change**:

- tonight's RPC swap (not in v46, expected), **and**
- the **UTF-8 decode fix** (`b64ToUtf8` instead of bare `atob`) — a committed, intended fix for mojibake
  on accented fighter names (José Aldo / Michał Oleksiejczuk class) that has **never been deployed**.

⚠ **And the deploy is not a plain one:** v46 reports `import_map: false` and inlines
`https://esm.sh/@supabase/supabase-js@2`, while the repo imports the **bare specifier**
`@supabase/supabase-js` against `supabase/functions/deno.json`. Per the recorded deploy recipe, that
deploy **must** pass `deno.json` in `files` **and** `import_map_path: "deno.json"`, or the function
boot-fails — and a boot failure is **not** reported by the deploy API, which returns `ACTIVE` regardless.
It must also keep **`verify_jwt: false`** (custom Bearer auth) or every cron tick 401s.

👉 **Left for a deliberate call rather than done blind, because the deploy ships a second behavioural
change Trevor has not seen.** The procedure is known and verifiable: deploy with `deno.json` +
`import_map_path` + `verify_jwt:false`, then confirm with the **unauthenticated boot probe** (a plain-text
`401 Unauthorized` is the function's own check and proves the module loaded; a JSON rejection is the
gateway). Rollback is the v46 body, which is still retrievable via `get_edge_function`.
**Until it is deployed, the RPC's own FALSIFIER applies: `get_fmv_snapshot_for_editions` at 0 calls a week
from now means the caller never landed.**
