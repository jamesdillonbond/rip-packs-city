> ⓘ **SUPERSEDED — filed late (2026-09-12) from the claude.ai Project archive; no action for the drain.** This filing was written by a Cowork cloud pass between 2026-08-29 and 2026-09-01 that could not push, so it never reached `docs/overnight/inbox/` at the time; its ledger entry DID land. It is committed now, unedited below the banner, so that citations by path resolve and the record is complete. **Read the ledger entry for that pass, not this body.**
>
> Recovered by the 2026-09-12 Cowork session that pruned the Project (`docs/overnight/ledger.md`, 2026-09-12 · "a third push path from Cowork").

# 2026-09-01T21:00Z — a public team-page RPC was over its own timeout, and the obvious fix was a regression

**Pass:** cloud-only, fired 20:58Z by the **duplicate** `58 */2` task. DB `now()` 20:59:02Z = 13:59 PT. Repo read at `f8743c3`.

## What this pass changed

`get_team_activity` (public `/<collection>/team/<slug>` Market Activity) now has a **gated** per-edition candidate path. Migration `20260901211338`.

- `detroit-shock` (5 editions): **78,291 → 4,241 buffers**, 6,953 → 21 ms.
- `seattle-supersonics` (36): **24,231 → 5,219 buffers**, 8,476 → 22 ms (it was **over** its own 8 s cap).
- `los-angeles-lakers` (639): **5,537 → 5,580** — unchanged control, wide path untouched.

93 of 171 team pages sit in the affected band.

## Three things worth carrying forward

1. **`force_custom_plan` was refuted on buffers (78,291 → 78,291) while the wall clock halved.** Second time in one day. The first one shipped and had to be reverted.
2. **The unconditional lateral would have been a 3.7×-buffers, 129×-wall regression for popular teams.** Cost is ~33 buffers/edition, so the fix *must* be gated on the candidate count.
3. **A stored baseline is not a valid control on a live-ingest table.** 3 of 4 apparent diffs were just new sales landing between capture and compare. Both arms must be evaluated in one MVCC snapshot.

## Open, for the next pass

- **jobid 433 builds `idx_wmc_lock_wallet_coll_cover` at 02:10Z and has no teardown.** After ~02:40Z check `indisvalid`. True → unschedule 433 and re-measure `get_lock_check_batch` on buffers. False → **drop the index** (a failed CIC leaves it invalid and `IF NOT EXISTS` will never retry; `run_wmc_reindex_verify()` cannot see it because its invalid scan only matches `*_ccnew`).
- **`idx_wmc_cohort_cover` `idx_scan` = 12,042 at both 21:03Z and 21:16Z** — the same value as 18:23Z / 19:04Z / 20:21Z. ~2 h 53 m of zero scans while its covering index took +114,329. The queued drop is still right; still hold it for 02:00–04:00Z.
- **Vercel `level=error` reads fine on a 45-min window** — the 20:18Z pass's timeout was scope-size, not a broken instrument. In those lines: a distinct **HTTP 429** class is mixed in with the known 530 dead-host class in `/api/wallet-search`. Separate them when the Atlas port lands.
- **`fmv-backfill` verified from primary data:** all 5 failures on 2026-08-30, zero since, 5 clean runs today. Clears 2026-09-02 00:00 UTC. Do not fix again.
- **This was the duplicate task's firing** — third refusal-confirmed request for Trevor to delete `trig_01AZzLzkTPp5xbSjK1EFmeCw`.
