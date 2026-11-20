# Daytime health monitor — 2026-11-19 ~04:05Z

**Run:** rpc-daytime-monitor (read-only sense pass), cloud container + laptop-VM clone push.
**Headline:** sweep is GREEN except for one new trust-health BREACH, which is a pure downstream
consequence of the already-tracked #218 Dapper Studio 530 outage. No new bug, no new breakage.

## Sweep result (all clean unless noted)
- Security 4/4 clean (`invariants` / `secdef_anon` / `rls_off_base` / `anon_write_holes` all `[]`).
- `detect_stalled_pipelines()` `[]`; `check_pgcron_recent_failures()` `[]`; sentinel TS-UUID-48h = 0;
  `ts_uuid_dupes_created_24h` = 0; `wmc_null_edition_key` `[]`; cross-collection mat staleness `[]`.
- Artifact validation: **13/13 live dashboards' SQL objects resolve** (65 relations + 7 functions
  checked by `to_regclass` / `pg_proc`, 0 missing). cowork-skills dir = 16 html (13 live + 3 retired
  per #114), no new/unexpected file.
- Vercel: production `65598a03` READY; the two newer CANCELED deploys are docs-only commits
  superseded by rapid concurrent pushes (normal). No ERROR deploys.
- `gha-schedule-watchdog`: last 6 runs ok=true (GitHub schedules delivering again; the snapshot's
  32%/3d failure_rate is the resolved 11-17/18 outage window, not current).

## The one finding (NEW since the 01:05Z tick, which read "all green")

**Candidate — trust arm `pinnacle_render_floor_stale_hours` has no #218 suppression and now BREACHes under the outage (LOW, sense-only).**
- **Source:** `rpc_ops_snapshot().trust_health_breaches` = `["pinnacle_render_floor_stale_hours"]`,
  value **30.5h** vs breach_at 30. New since the 2026-11-19T0105Z monitor filing (not present then).
- **Cause (not a spell — snapshot returned fast, no IO-wait signal):** the render-floor writer
  `pinnacle-catalog-floor-refresh` (Vercel cron `45 1,7,13,19 UTC`, Studio-GraphQL source) has been
  0-ok / 0-rows on `floor GQL 530` since the #218 Dapper Studio outage began ~11-17 16:23 PT (last run
  01:45Z, zero ok). With the floor writer unable to run for ~36h, `floor_ask_updated_at` has aged past
  the 30h guard that the daily writer normally keeps it under. The breach is #218, nothing of ours.
- **Why it's worth a night-pass decision, not just noise:** when #218 began, the pack-sales sentinel
  arms were explicitly **acked under #218** (ledger 11-17, acks renewed, expiry 11-20) so they would
  not page for an upstream outage, and the failure_rate arm got the 530→medium cap
  (`20261119014903`). This trust arm got **neither** — so as long as Studio stays down it will sit in
  BREACH and (if it pages like the pack-sales arms did) generate upstream-outage page noise.
- **Risk read:** LOW / read-only decision. No production or pricing change. Self-clears on the first
  successful floor-refresh tick once Studio recovers (#218), so doing nothing is also safe.
- **Suggested action (quiet, reversible — night pass / Trevor):** (1) confirm whether a
  `pinnacle_render_floor_stale_hours` BREACH actually pages (`/api/check-alerts` wiring) or only
  shows on the board; (2) if it pages, ack/suppress it under #218 the same way the pack-sales arms
  were acked, with an expiry tied to the #218 recovery check, OR deliberately leave it as a
  board-only breach; (3) no change to the floor writer itself — it is correct and will resume on
  Studio recovery. Do **not** "fix our lane" for the 530 (focus-file standing rule).

## Known / not re-filed (all tracked)
- The full 530 pipeline_alerts cascade (pack-sales / pack-opens / pack-EV / snapshot-pack-asks /
  pack-nft-identity / wallet-pack-pulls, all capped medium) = #218, expected.
- `pg_net_http_403` CRITICAL / `_404` / `_400` HIGH = the known #241 class: Cloudflare "Just a
  moment" challenges + self-inflicted Atlas schema probes (`series_id is required`,
  `distribution not found`) on dispatchers that don't persist a request_id. Base-rate, nothing lost.
- `[sniper-feed]` Pinnacle stale-listing 500s (7 errs / 6 users, 14h) = #218 Pinnacle freeze, already
  attributed in the ledger (line 48). Entity-section statement-timeout tail (get_set_activity /
  get_player_top_sales / get_team_squeeze, "degrading to empty") = chronic, first-seen Aug–Oct.

## ✅ RESOLVED by observation 11-19 (arm ok; self-cleared with the #218 migration to Atlas)

`pinnacle_render_floor_stale_hours` read 3.7 h / ok on 2026-11-19 ~9:30 PM PT (cleared by 11-19 morning, ledger health line). `pinnacle-catalog-floor-refresh` still pools 5/8 Studio-530 failures at medium and ages out by itself. Marked by the 2026-11-19 Cowork cloud audit pass; no change made for this filing by that pass.
