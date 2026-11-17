# E2E DOM Smoke stayed red on the batch-1 band suppression — verify the cfa4711 re-pin cleared it

- **Filed:** 2026-11-06 ~22:05 UTC (02:05 PM PT), daytime health monitor (read-only pass).
- **Priority:** LOW for platform impact (no data/user effect; band suppression on the Binder tab is by design). Visibility: a red `E2E DOM Smoke` badge on `main` until the next scheduled run confirms the re-pin.
- **Source:** `docs/overnight/metrics-latest.json` verdict (daytime audit pass close-out, 20:55Z) + repo `cfa4711d0` + `.github/workflows/e2e-smoke.yml`. GHA not reachable from this cloud sandbox (gh 403) or the laptop VM (gh unauthed), so the run result could not be read here.

## What
The daytime audit pass (close-out 12:55 PM PT / 20:55Z) recorded: *"E2E DOM Smoke was red since ~10:47 AM on my batch-1 band suppression — re-pinned cfa4711; next scheduled run decides."* The wallet-band monitor had been asserting the band on the Binder tab of `/<c>/collection`, where batch 1 of today's audit intentionally suppressed it. `cfa4711d0` ("test(e2e): the wallet-band monitor reads /nba-top-shot/market — the Binder tab suppresses the band by design since 11-06") re-points the monitor at `/nba-top-shot/market`, where the band is still shown.

## Why it is a candidate, not a finding
The fix is in the tree (`cfa4711d0` present on `main`). Whether the next scheduled `e2e-smoke.yml` run went green on `cfa4711` (or a later HEAD) cannot be measured from a cloud sandbox — the daytime monitor has no GHA access. This is a clean verify-the-ship handoff, not an independent breakage. Everything else in the 22:05Z sweep was clean (security 0, trust 40/40, stalled [], pg_cron clean, 13/13 dashboards OK, Vercel latest READY, client-beacon 0/24h).

## Suggested action (night pass — has GHA access)
Read the latest `E2E DOM Smoke` run on `main`:
- Green on `cfa4711d0` or later → close; the re-pin worked, no residual red.
- Still red → the band monitor is asserting on a surface where the band is now suppressed, or `/nba-top-shot/market` dropped the band too; inspect the failing assertion and adjust the monitored route (code/workflow — night pass or Trevor).

No revert needed — `cfa4711` only changes which route the monitor reads.

## Drained 2026-11-07 — verified green; closed
Read from GHA (Cowork cloud, ~10:55 AM PT, `gh run list --workflow=e2e-smoke.yml`): the first `E2E DOM Smoke` run after `cfa4711` was **green at 00:15Z 11-07 on `e8ca0d6`**, and every completed run since is green (e8ca0d6 · 3a4251f · 5d2e6be · f7bf39e · a0727f9 · f9755d2 · ec7a1eb · 34946dc · 70f143a · … · 93d5af4 · 523e590 · 2bb0024 · 25d434e · 80569ca · e4cafbd); the handful of `cancelled` rows are concurrency supersedes by a push a minute later, not failures. The re-pin worked; no residual red. One UNRELATED red on 11-07 (`5708946`, ~08:40 AM PT) was the iOS zoom-floor positive control (≥ 5 form controls on the pre-search binder) after the binder's filter bars were made to wait for a wallet — re-pointed to a loaded wallet in `347ba08`, green on the next run (ledger, 11-07). No action.
