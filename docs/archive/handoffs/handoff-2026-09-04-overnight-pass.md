# RPC overnight pass — 2026-09-04 (Pacific)

**Mode:** genuine overnight (01:03 PT, clock verified against DB `now()` — no skew). **GIT PUSH UNAVAILABLE this run** — the harvested pushurl carries no credential (cloud session; only the device-VM path can push, per memory + the prior two nights). So: DB migrations and artifact repairs were available; code commits / Vercel deploys were NOT and are queued. Continuity files written in the clone and **mirrored to the mount UNCOMMITTED**.

**Verdict: GREEN with known-carried items. Nothing shipped — nothing was safe to ship autonomously in NO-PUSH mode. No regression from last night's ~10 ships.**

## Post-ship regression watch (last ~24–48h ships)

Last night was very active (concurrent Cowork desktop-VM + Claude Code sessions). Re-measured the targets:

- **`match-topshot-players` gating (#54, edge fn v30):** the 2026-09-04 08:00Z cron tick logged `ok=true, gated=true` — **exactly the predicted post-ship state.** PASS.
- **`topshot-circulation-onchain` (new daily cron, chunk-size fix `7df740ca`, PAIRS_PER_SCRIPT=40 confirmed in `origin/main` HEAD):** the only tick since is the known 2026-09-04 04:05Z failure (`Flow REST HTTP 400`) that ran on the OLD code before the fix deployed. The `running_but_not_succeeding · medium` arm is correctly firing on it (its job). **Next real read: the 2026-09-05 04:05Z tick** — expect `ok=true`, `pairs_read ~= 9,5xx`, `script_errors 0`, `changed` small. Not a regression.
- **`get_top_movers` (sales-backed + in-window-sale filter, `20260904041433`/`041544`), `get_allday_sniper_deals` rewrite (`20260904052858`), `get_wallet_collection_snapshot` staleFmv (`20260904045817`), S1 thumbnails (`20260904052346`), cadence-watchlist 40 arms (`20260904044417`):** all present in the schema, none reverted; no correlated new pipeline failure or trust breach.
- **Username cache-first resolver (nine routes, `d0378dd0`):** code ship; can't re-verify without a push, but no new 500 class appeared in the alerts.

No shipped change correlates with a regression. **No auto-revert taken.**

## Health-drift triage (rpc_ops_snapshot @ 08:05Z)

- **Security:** invariants / anon_write_holes / rls_off_base / secdef_anon_violations all `[]` — **clean.**
- **Trust breaches (2, both known-carried, neither a regression):**
  - `public_board_slow_count` — 3 public views over the 5 s slow bar in the 06:28Z sweep: `v_topshot_parallel_premiums` **8.1 s** (3,868 rows), `pack_table_rows` **5.7 s** (5,529), `candy_player_board` **5.2 s** (100). **`empty_or_error = 0` — no board is down, only slow.** Standing IO-bound class on Small compute; value oscillates 1–3. Perf work is a careful daytime buffers A/B (name the caller, warm-vs-warm, BUFFERS not timings), not a 1am blind index. QUEUED.
  - `unmapped_resolution_backlog_max` = **172** (breach_at 100) — the AllDay permanent-class floor, **declining** (209 -> 184 -> 172 over three reads). Structural, do not chase.
- **`pipeline_alerts`:**
  - `allday-pack-opens-backfill` — **high**, 65/123 failed (52.8%), 503s. KNOWN/FILED 09-03 (edge-fn code: poison-range rule + AbortSignal; `supabase/functions/ingest-allday-pack-opens`, CLI deploy). Off-limits for the night pass; queued.
  - `pg_net_http_403` — **critical by severity, benign in fact.** 23 responses over ~90 min, body is a Cloudflare `Just a moment...` bot-challenge; these are pg_net-**dispatched probes**, not edge functions, and **none correlates with a failing `pipeline_runs` row** (the 24h fails are 503/400/upstream-530, not a 403). Same self-inflicted-probe class flagged benign 09-03. No action.
  - 4 x `running_but_not_succeeding` (info/medium): `ingest-topshot-challenges`, `topshot-catalog-backfill`, `topshot-misattrib-drain` (all three hit the decommissioned `public-api.nbatopshot.com`), and `topshot-circulation-onchain` (the known pre-fix tick above).
- **`stalled_pipelines`:** `[]`. **`sentinel_ts_uuid_editions_48h`:** 0. **`fmv_sanity_flags`:** 0. **`ts_uuid_dupes_created_24h`:** 0.
- **Artifacts:** 11 in the manifest; none flagged broken/stale by the daytime monitor this cycle and none touched by a breaking schema change. Per the skill, working artifacts are not regenerated. None repaired.

## Overnight deltas vs `metrics-latest.json` (04:30Z desktop-VM run)

- db_size_mb **16,032 -> 16,136** (+104, normal growth).
- unmapped_resolution_backlog_max **184 -> 172** (declining).
- public_board_slow_count 1 -> 3 in the live probe (oscillates; sweep-age dependent).
- FMV HIGH+MED per collection tonight: Top Shot **7,945** (2,130 H + 5,815 M), All Day **1,559** (141 H + 1,418 M), Golazos 2, UFC 0 (closed), Pinnacle in its own table.
- editions: candy_mlb 125 . ufc_strike 518 . nfl_all_day 6,190 . nba_top_shot 19,988 . laliga_golazos 575.

## Queued (nothing new a night pass can safely ship; all carried forward)

1. **`allday-pack-opens-backfill` edge-fn fix** — poison-range skip after N identical transient failures + AbortSignal on the spork-proxy fetch. Edge-fn code (CLI deploy); AllDay is SUNSET — decide whether the deep-history backfill is worth its edge time. Night-count: 2.
2. **Three dead-host Top Shot pipelines** (`topshot-badge-set-backfill`, `topshot-catalog-backfill`, `topshot-misattrib-drain`) — pause (jobid-16 precedent) or port on-chain. `topshot-misattrib-drain` residue ~215 rows -> one-off script. (inbox `2026-09-04T0220Z §1`.) New.
3. **`fmv-recalc` / `query_sql` restructure** — biggest DB reader; give each of the 7 inline scans a named function + scoped predicate/covering index, measured by BUFFERS with a control. Do NOT lower fmv-recalc cadence (08-30 cut was reverted). (inbox `2026-09-04T0500Z`.) New.
4. **Three slow public views** (`v_topshot_parallel_premiums` 8.1 s, `pack_table_rows` 5.7 s, `candy_player_board` 5.2 s) — the `public_board_slow_count` breach. Careful buffers A/B before any index. Carried.
5. **Operator-only, unchanged:** #22 defeated credential purge (rotate regardless); #23/#25 (25 edge fns not on `main`; no sentinel arm on the three daily detectors); #58 `OPENSEA_API_KEY`.

## Failed / blocked / reverted

None. No production shipping attempted (NO-PUSH + no safe additive-DB win). No hard-stop triggered.
