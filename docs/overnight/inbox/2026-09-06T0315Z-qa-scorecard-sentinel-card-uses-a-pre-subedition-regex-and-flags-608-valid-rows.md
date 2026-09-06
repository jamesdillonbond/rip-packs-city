# `rpc-qa-scorecard`'s "Sentinel leak (48h)" card uses a pre-subedition regex and displays 608 valid rows in the amber "watch" band

*rpc-daytime-monitor · 20:15 PT / 03:15Z 2026-09-06 · READ-ONLY sweep, nothing shipped · inbox written to mount, push unavailable (harvested remote has no credentials — cloud/no-push env, expected)*

## What tripped

Validating the live artifacts, `rpc-qa-scorecard`'s payload runs clean but its **`sentinel` key returns 608** where the two authoritative leak instruments both return **0**:

- `rpc_ops_snapshot().sentinel_ts_uuid_editions_48h` = **0**
- `rpc-live-health`'s `leak_48h` = **0**
- `rpc-qa-scorecard`'s Sentinel card = **608** → renders in the amber **watch** band (its thresholds are `n<250` ok, `n<2000` watch, else alert)

## Root cause — a stale regex that predates the `::subedition` external_id format

The three instruments key on different regexes:

| instrument | regex | reads |
|---|---|---|
| canonical sentinel + rpc-live-health | `^[0-9]+:[0-9]+(::[0-9]+)?$` (allows `::N`) | 0 |
| rpc-qa-scorecard card (`sentinel` key, artifact `index.html` ~line 127) | `^[0-9]+:[0-9]+$` (no `::` suffix) | 608 |

Confirmed by direct query against `editions` (collection `95f28a17…`, created <48h):

```
strict_regex_flags   = 608   -- ^[0-9]+:[0-9]+$
canonical_regex_flags = 0    -- ^[0-9]+:[0-9]+(::[0-9]+)?$
subedition_fmt        = 608   -- ^[0-9]+:[0-9]+::[0-9]+$
samples               = {116:4093::10, 116:4094::10, 116:4092::10}
```

**All 608 flagged rows are well-formed subedition-format external_ids** (`setID:playID::subeditionID`), i.e. legitimately-keyed editions, not the inert-UUID leak the card is meant to catch. The card's regex simply predates the subedition format the DQ4 sentinel was later corrected to allow.

## Risk read

Low. **Data is correct; the artifact display is a false positive.** No leak exists (the canonical sentinel is the source of truth at 0). The only harm is that anyone reading the QA scorecard sees a persistent amber "608" that reads as a data-quality watch when nothing is wrong — the "permanently-amber instrument is indistinguishable from a broken one" anti-pattern. It will keep climbing as more subedition rows are minted.

## Suggested action (night pass — artifact edit, not code/DB)

Align the `sentinel` leg's regex in `rpc-qa-scorecard`'s `index.html` (~line 127) to the canonical `^[0-9]+:[0-9]+(::[0-9]+)?$` used by `rpc_ops_snapshot()` and `rpc-live-health`, so all three agree at 0. Update-artifact only; no schema or code change. Verify post-edit that the card reads 0.

## Not findings (swept, all known/expected — recorded so they are not re-raised)

- **`allday-pack-opens-backfill`** 93.3% fail over 2 days — the pipeline **stopped firing after 09-04 04:56Z** (~46 h silent); the 2-day window just captures its pre-stop failures. Already filed to Trevor (09-05 overnight handoff).
- **`topshot-badge-set-backfill`** stall (1 of 1 `detect_stalled_pipelines`) — deliberately unscheduled 09-04; false-positive already filed today (`2026-09-05T1810Z`).
- **Trust breaches:** `unmapped_resolution_backlog_max` 119 (declining 172→148→132→119, worker-side) and `public_board_slow_count` 1 (`topshot_2025_rookie_cohort_stats` — load-dependent contention, focus.md item 7). Both known, not new.
- **`atlas-editions-upstream-403`** info — benign Cloudflare challenge, attributed, no rows lost. Known.
- **`allday-lock-refresh`** 40.4% fail — Flow 400 script errors on specific wallets (upstream data), steady-state partial failure, not new.
- **Security** 0/0/0, **pg_cron** clean, **DB not in a spell** (`db_active`=0), **latest READY prod deploy** 09-05 17:37Z (newer commits are docs-only → correctly CANCELED by ignoreCommand).
