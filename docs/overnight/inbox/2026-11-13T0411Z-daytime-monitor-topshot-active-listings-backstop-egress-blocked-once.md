# Daytime monitor (04:05Z sweep) — `topshot-active-listings-ingest-backstop` hit `egress_blocked` once (1/7d); no freshness impact observed

**Source:** `pipeline_runs` — `topshot-active-listings-ingest-backstop`, `ok=false`, `error='egress_blocked'`, `started_at=2026-11-13T01:58:11Z`. Only occurrence of `egress_blocked` in the last 7 days (first=last=01:58Z); this lane ran once in 24h and that single run failed.

**Risk read:** LOW, and NOT in a spell (positive control: `pg_stat_activity` io_wait 1 / active 1). This is the backup lane, not the primary feed. Blast radius looks nil:
- `detect_stalled_pipelines()` returned `[]` — the primary `topshot-active-listings-ingest` (7 ok / 0 fail in 24h, last ok 2026-11-12T22:13Z) is within its cadence threshold, not stalled.
- TopShot freshness is OK by every downstream read: `topshot_fmv_stale_hours` 0.3 (breach_at 6), `topshot_sold_floor_asks_found` 1 (ok), and the Atlas market feed last drained 04:05Z / newest event 04:04Z. TS ask/listing data is reaching the boards via Atlas regardless of this backstop tick.
- `egress_blocked` is a distinct, deterministic error class — the egress proxy/allowlist refused the outbound call — unlike the chronic by-design Cloudflare `403` challenges on the Atlas lanes (those re-ask and lose nothing).

**Suggested action (RE-MEASURE, not a conclusion):** On the next daytime sweep, check whether `egress_blocked` recurs on this lane. If it stays a one-off, age it out — no action. If it recurs, check the egress allowlist for the backstop's upstream host: a single lane newly reporting `egress_blocked` while the rest of the platform is green points at an allowlist/proxy gap specific to that host, not an upstream outage. Do not touch the primary lane — it is healthy.

---

Full sweep otherwise GREEN (2026-11-13 04:05Z):
- Security x4 clean (invariants / anon_write_holes / rls_off_base_tables / secdef_anon_violations all []).
- `stalled_pipelines` [], `check_pgcron_recent_failures()` [], sentinel TS-48h 0, `ts_uuid_dupes_created_24h` 0.
- Trust health: 40/41 ok. One breach, KNOWN + TRACKED (focus.md #246, WATCH-not-fix): `edition_integrity_flags` 316 vs 250 — composition 308 Candy MLB name-only residue (bad circ 101 / missing tier 106 / missing thumb 101) + 8 NBA thumbnail baseline. Continuing its decline (10,015 → 2,660 overnight 11-12 → 316 now). Not re-raised.
- Dashboards: 13/13 live artifacts' referenced relations + functions all resolve against the live DB.
- Vercel: latest production READY (`c5e28b8f3`, = repo HEAD at sweep time); CANCELED builds are Trevor's superseded push train, no ERROR state.
- Other recent `ok=false`: Atlas `403`/`404`/`400` info rows (by-design, lanes fresh); `candy-collections-census` RETIRE "refused" rows (the shipped completeness/cap guard working as designed — Overdrive Rewards 0-card walk, Absolute Batman 718-card vs 25% cap); isolated census lock-timeout / set timeout during the active Candy remediation. None new, all owned.
