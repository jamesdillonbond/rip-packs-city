> ⓘ **SUPERSEDED — filed late (2026-09-12) from the claude.ai Project archive; no action for the drain.** This filing was written by a Cowork cloud pass between 2026-08-29 and 2026-09-01 that could not push, so it never reached `docs/overnight/inbox/` at the time; its ledger entry DID land. It is committed now, unedited below the banner, so that citations by path resolve and the record is complete. **Read the ledger entry for that pass, not this body.**
>
> Recovered by the 2026-09-12 Cowork session that pruned the Project (`docs/overnight/ledger.md`, 2026-09-12 · "a third push path from Cowork").

# 2026-09-01T1858Z — this pass is the duplicate task, and the queued index lever is confirmed

**Fired** 18:58:11Z by `trig_01AZzLzkTPp5xbSjK1EFmeCw`, session `cse_012wsm6DdVr6qupgBKCdgaEv`. DB `now()` 18:58:48Z = 11:58 PT. Cloud-only, no push. `origin/main` 355b01d1.

## The one thing that needs a human

Two enabled, unbound, every-2h autonomous-pass tasks fire 40 minutes apart. **This session is the older one.** `update_trigger(trig_01AZzLzkTPp5xbSjK1EFmeCw, enabled=false)` — the reversible fix — was refused with *"MCP tool call requires approval"*, and a scheduled run has nobody to approve it.

- Disable or delete `trig_01AZzLzkTPp5xbSjK1EFmeCw` (`58 */2`). Keep `trig_018AyNcnbCZuYb1Ztts6rbBR` (`18 */2`).
- ⛔ Do not create a replacement from the MCP; `created_via: meta_mcp` is why neither is device-bound. Re-create from the desktop app and check the approval card offers a device/folder binding *before* approving.

## Carried forward

- `check-migration-parity` still RED: `20260901110757`, `20260901112618`, `20260901113812`, `20260901183010`. Recover byte-exact with the script; never retype.
- **Open thread 14 lever is ready to execute in the 02:00–04:00Z band.** `idx_wmc_cohort_cover` is a strict prefix of `idx_wmc_wallet_coll_ek_fmv` with the same INCLUDE payload, is now *larger* on disk than its own superset (296 MB vs 247 MB), is chosen by the planner for **none** of the three shapes it was built for, and took **zero scans in 41 minutes**. `DROP INDEX CONCURRENTLY` via `execute_sql`. Drop `idx_wmc_cohort_cover` only — `idx_wmc_collection_id` is still taking ~30 scans/hour.
- Open thread 14 in known-issues still reads ✅ CLOSED and should be re-opened (its own verify is `ok:false`). Flip the item body, then regenerate the ITEM-INDEX.

## Health

GREEN. Security invariants clean, no stalled pipelines, 2 known alerts, 1 known declining trust breach (213 vs 100). Nothing new since the 18:18Z sweep.
