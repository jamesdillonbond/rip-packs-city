# The first RATE-based IO ranking this platform has had — and `fmv-recalc` is 4.8 % of it, not the top reader

**Filed 2026-09-14 ~7:4x AM PT (14:4xZ), Claude Code cloud. READ-ONLY — nothing shipped.**
Every saturation filing here has ranked `pg_stat_statements` by its **cumulative** `shared_blks_read` column. This is the same ranking taken as a **delta across a clean 60-minute window**, with the two keying traps that void such a delta both avoided (see [database.md](../../reference/database.md)).

## 1 · The window, and why it can be trusted

Two snapshots keyed as pgss keys itself — `(userid, dbid, queryid, toplevel)` — **13:34:11Z → 14:34:26Z, 1 h 00 m 14 s**, inner-joined on the full key, with any entry whose `calls` went backwards dropped. **Zero entries were readmitted in the window**, so every delta below is an honest difference rather than a re-admitted lifetime.

**480 statements did any reading at all. Total: 7,058,722 blocks ≈ 53.9 GB ≈ 919 MB/min.**

## 2 · The ranking

| # | blocks read | calls | exec s | share | statement |
|---:|---:|---:|---:|---:|---|
| 1 | 1,078,200 | 13 | 190 | **15.3 %** | `allday_resolve_unmapped_via_atlas()` |
| 2 | 1,004,092 | 31 | 596 | **14.2 %** | `atlas_listing_verify_tick()` |
| 3 | 493,841 | 30 | 335 | **7.0 %** | `atlas_market_drain()` |
| 4 | 339,691 | 6 | 297 | **4.8 %** | `refresh_wmc_fmv_changed()` |
| 5 | 254,746 | 191 | 80 | 3.6 % | a PostgREST RPC |
| 6 | 185,947 | 2 | 85 | 2.6 % | `reconcile_wmc_metadata_from_editions()` — `source: POST /mcp` |

⭐⭐ **THE ATLAS LANES ARE THE INSTANCE'S READERS RIGHT NOW: 37.2 % of the hour's disk reads across all Atlas statements**, with the top three alone at **36.5 %**.

🚨 **AND `refresh_wmc_fmv_changed` — the CUMULATIVE #1 by a wide margin (251.9 M blocks, ~22 % of all reads since 08-12, the statement CLAUDE.md and roadmap-status both describe as *"it owns the DB's #1 reader"*) — is 4.8 % as a RATE, in fourth place.** It fired **6 times** in the window, so this is not a job that happened to miss its slot.

## 3 · ⛔ What this does NOT say

- ⛔ **It does not say fmv-recalc is cheap or that the cumulative reading was wrong.** A cumulative total and an hourly rate are different quantities and both are real: fmv-recalc has read more than anything else over 33 days *and* is not what the instance is doing this hour. **What it does say is that "the DB's #1 reader" is a statement about a cumulative column, and should not be quoted as a statement about now.**
- ⚠ **ONE 60-MINUTE WINDOW, 6:34–7:34 AM PT on a weekday.** A 6-hourly job that did not fire in it is under-represented by construction. **Re-derive before acting; do not size a fix off this table alone.**
- 🚨 **THE OBSERVER IS IN THE RANKING: statements tagged `source: POST /mcp` are 4.8 % of the window** — agent sessions, mine and a concurrent one doing wmc repair work. **The measurement is part of the load it measures**, which is this repo's own standing warning, here as a number rather than a caution.
- ⚠ **`shared_blks_read` IS NOT PHYSICAL DISK IO.** It counts blocks not found in `shared_buffers`; the OS page cache may still have served many of them. **So 919 MB/min ≈ 15.3 MB/s is an UPPER BOUND on disk traffic, not a measurement of it** — and comparing it to the compute tier's 22 MB/s burst floor (CLAUDE.md) suggests the hour ran near that budget **without establishing it**. The honest claim is the ranking and the shares; the absolute byte rate is a ceiling.

## 4 · What would make this decisive

1. **Repeat across several windows at different hours** — the same two snapshots, an hour apart, cost one statement each. A table of four windows would separate "the Atlas lanes are the readers" from "the Atlas lanes were the readers at 7 AM".
2. **Split the Atlas total by lane** and check each against its own schedule: `atlas_listing_verify_tick` ran 31 times in the hour at 19.2 s/call average, `allday_resolve_unmapped_via_atlas` 13 times but reading 83 k blocks each.
3. ⛔ **Do not re-rank by the cumulative column to "confirm" this.** That is the instrument this filing exists to replace.
