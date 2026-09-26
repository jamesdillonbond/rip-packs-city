# Daytime monitor candidate — 2026-09-26 ~00:06Z (≈5:06 PM PT 09-25)

## sync-nba-projections: 100% failure (8/8 runs) over the last 24h — `all_upstreams_failed`, zero successful runs

- **Source:** `pipeline_runs` — every 3-hourly tick 09-25 00:07Z → 21:07Z is ok=false, error `all_upstreams_failed`. Standing, not new tonight (the 09-25 08:12Z metrics baseline already logged it at 8 fails/24h). Not in the ledger or on the Declined list, so it has never been dispositioned.
- **Risk read:** LOW. The lane fails SAFE — ok=false with no rows written — so no bad projection data reaches any surface. The only harm is that a permanently-red lane pollutes the 24h failure counters and can mask a future genuine break behind expected red.
- **Likely cause (UNVERIFIED — ordinary read, not a spell):** late-September NBA offseason (preseason ~early Oct, regular season ~late Oct), so the projection upstreams plausibly have nothing to serve and `all_upstreams_failed` is every upstream returning empty/closed rather than a code fault. Inferred, not confirmed.
- **Suggested action (night pass / Trevor):** characterize offseason-empty vs genuinely-broken by hitting each upstream directly. If offseason-expected, make the lane exit ok / no-op ("no games in season") instead of logging ok=false, so it stops burning the failure budget and a real break stays visible. No code change without that characterization first.

## Disposition — 2026-09-25 ~5:45 PM PT (Claude Code, Trevor's box)

**Already dispositioned: this is known-issue #8, SHELVED 2026-09-23 under Trevor's delegation ("no paid projections provider before revenue"), with the alert deliberately muted until 10-13.** It was not in the ledger's Declined list because the decision lives in `docs/reference/known-issues.md` #8 — grep there before filing a pipeline that has been red for weeks.

- ⛔ **The offseason hypothesis is refuted by #8's own measurements:** every upstream returns **403** (blocked), not an empty slate — the lane has failed 100% since 2026-08-04, well before any offseason gap would matter. So "exit ok when there are no games" is the wrong fix: it would turn a real block into a green run.
- **Why the lane keeps running:** it recovers on its own if the upstreams unblock, and it writes nothing when they fail (fails safe; the Fast Break panel already reports `projections_unavailable`). Pausing it would remove the one signal that the block has lifted.
- **What remains open is #8's, not this filing's:** the provider decision before NBA preseason, and the 10-13 mute expiry. No action taken here.
