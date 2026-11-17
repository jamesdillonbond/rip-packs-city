# Daytime monitor — 2026-09-30T15:09Z (first-tick, 08:04 PT)

Health sweep GREEN across the board: security 4/4 clean, trust 38/38 ok (0 breaches), stalled_pipelines [], pg_cron failures [], cross-collection refresh fresh (cohort 10:02Z cnt 195, overlap 10:35Z, both jobs active, runs succeeded), sentinel 48h = 0, Sentry 0 unresolved/24h, no ERROR Vercel deploys, artifacts rpc-live-health + rpc-qa-scorecard payload queries validated clean against the post-migration schema. Positive control clean (db_active 1, snapshot fast) — NOT in a saturation spell, so the read below is a real cause, not a symptom.

## New candidate

### LOW · panini-collector-walk hits `usernotfound` on 2–3 targets (config hygiene)
- **Source:** `pipeline_runs` pipeline `panini-collector-walk`; snapshot failure_rate alert (2/6 runs failed over 3 cal days; 4 fails/24h). Error rows 13:37–13:39Z 09-30: `no collection list (url=https://nft.paniniamerica.net/usernotfound title="Panini Product" ...)`. Walk otherwise completes (7/11 ok today, 13 heartbeats).
- **Read:** one or more walked usernames in `PANINI_COLLECTOR_TARGETS` (scripts/panini-*) no longer resolve on Panini — the same recurring class as the 09-28/09-29 ledger config drops/renames (e.g. PDX_Blazer dropped, spinotronpc→spinotron). The generic usernotfound page does NOT name which target, so it must be identified by a per-target probe. NOT causing data harm: panini_coverage_pct_drop 3.9 (< 15 breach), panini_fmv_stale_hours 0.3, edition_integrity_flags 7 (ok). The separate one-off `per-walk cap of 10 min reached` fail (13:21Z) is the benign time-cap class, not this.
- **Risk:** low — config-only edit to the collector target list; no schema/data change.
- **Suggested action (night pass):** probe each `PANINI_COLLECTOR_TARGETS` entry against nft.paniniamerica.net, drop or rename the 404ing username(s) exactly as the prior ledger config entries; optionally append the offending username to the walk's error text so future instances self-identify.

_Not re-logged (already queued/known): topshot_offer_fill_backfill cursor stall [HIGH — inbox 2026-09-28T1511Z], pg_net_http_429 volume [HIGH — inbox 2026-09-29T2110Z, lock note "attributed/QUEUED"]. Atlas 403s / flow-rest 400 / unmapped-sales backlog are info/by-design._

## Disposition — Claude Code, 2026-09-30 ~10:25 AM PT: RESOLVED, three usernames dropped

- **The walk already names the target.** Each `panini-collector-walk` row carries `extra.username` and `extra.profile_state` (the filing's "does not name which target" reads only the `error` text). The 09-30 not-found rows were `philthy503` (6:37 AM PT), `juiceshack` (6:38) and `cazsreyem` (6:39), all `profile_state=not_found` with 0 rows written. None has ever resolved: 09-30 was the first walk for each.
- **Why:** these three were added 09-28 on the assumption that each collector's Panini name matches their Top Shot name (the `.bat` comment says so). Panini sends all three to `/usernotfound`, the same outcome that got Rigged and PDX_Blazer dropped on 09-29.
- **Fix:** removed from `PANINI_COLLECTOR_TARGETS` in `scripts/panini-collector-walk.bat`, with a comment naming them so the right spelling can be put back. No user env override exists on the box, so the next daily run picks it up. Their Flow `seeded_wallets` rows are untouched.
- The 6:21 AM `scottyj111` failure is the per-walk 10-minute cap (3,134 of 24,185 cards, partial read posted), the designed class. Not changed.
