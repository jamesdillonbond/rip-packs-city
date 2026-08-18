# The four-source caller rule is blind to Cowork artifacts — 8 live objects read as dead

**Filed 2026-08-18T1620Z · Cowork cloud · READ-ONLY · derived from artifact HTML, not from descriptions**

## Disposition of the open item first

`v_tracked_wallet_fmv_confidence` — flagged as carrying the same `FROM fmv_snapshots … GROUP BY`
shape as `drain_fmv_cold_tail`. ✅ **It is NOT a cost. Do not optimise it.**

Its only consumer is the Cowork artifact `rpc-tracked-fmv-confidence`, which re-queries it **when a
human opens the board**. There is no cron, no function, no view, no route. Optimising it would repeat
the `get_unmapped_resolver_targets` mistake — a fix shipped for a thing nothing calls. **Open item
closed on the caller check, not on a rewrite.**

## The general defect the check exposed

CLAUDE.md requires four sources before treating an object as a cost or as dead: `pg_proc.prosrc`,
`pg_views.definition`, `cron.job.command`, and a full-repo grep. ⛔ **A Cowork artifact is none of
them.** It lives outside the repo *and* outside the DB catalogue, so an object whose only consumer is
an artifact reads as **zero callers by every documented source** — and that points the wrong way in
both directions:

- read as *dead* → a cleanup sweep deletes it and silently breaks a live board
- read as *expensive* → someone optimises a query that runs on human open, not on a schedule

## Derived, not sampled — 8 artifact-only objects across 3 artifacts

Staged all **11** artifacts' HTML and extracted every `.from(…)`, `.rpc(…)` and inline-SQL `FROM …`,
intersected with real `pg_class`/`pg_proc` objects, then cross-checked all four sources:

| object | kind | sole consumer |
|---|---|---|
| `panini_deal_board` | view | `rpc-panini-squeeze-v2` |
| `panini_nation_board` | view | `rpc-panini-squeeze-v2` |
| `panini_pack_ev_board` | view | `rpc-panini-squeeze-v2` |
| `panini_player_board` | view | `rpc-panini-squeeze-v2` |
| `panini_special_serials_board` | view | `rpc-panini-squeeze-v2` |
| `v_topshot_pack_lifecycle` | view | `rpc-pack-lifecycle` |
| `v_topshot_pack_lifecycle_global` | view | `rpc-pack-lifecycle` |
| `v_tracked_wallet_fmv_confidence` | view | `rpc-tracked-fmv-confidence` |

**A "drop the unreferenced views" sweep run against the documented four sources would delete all 8 and
break 3 live boards.** Treat this table as the exclusion set until the rule is amended.

⚠ Near-misses worth noting, because they show the check discriminates: `panini_squeeze_totals`,
`v_rewards_economy`, `v_rewards_user_balances` each have exactly **one** repo caller and would survive;
`topshot_market_index_daily` has a **cron** caller. The 8 above are the ones with nothing.

## Method notes — one of them is load-bearing

- ⛔ **`supabase/migrations/**` MUST be excluded from the repo grep.** Every object is named by the
  migration that creates it, so including migrations makes *every* object look called and the check
  returns nothing. That single exclusion is what makes the result non-vacuous.
- The extraction reads artifact **HTML**, not the artifact *description* — descriptions under-name.
  My first pass off descriptions found 5 of these 8.
- ⚠ **Lower bound, not proof.** The regex catches literal `.from('x')` / `.rpc('x')` / `FROM x`; a
  dynamically-constructed name would be missed. And it covers the **11 artifacts on this device** —
  artifacts elsewhere would add to the set.

## Recommended amendment

Add a fifth source to the caller rule: **`list_artifacts` + the artifact HTML** (stage via
`device_stage_files` with `artifact_ids`). It is the only source that sees this class, and it is one
call. The rule's own phrasing already anticipates the failure — *"every guard's own derivation fixes
its blast radius"* — this is that rule applied to itself.

⚠ **Not added to CLAUDE.md from here.** The file is at its size equilibrium, so this needs to displace
something rather than append, and that is a judgement call for Trevor. The four-source list lives in
the **Measurement discipline** section.

**No changes made.** Read-only; no DB, migration, cron or code change.
