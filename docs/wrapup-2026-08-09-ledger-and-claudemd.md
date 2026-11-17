# Wrap-up 2026-08-09 — two doc gaps, paste-ready

Both are things I can't safely write from the cloud session: `ledger.md` is 1,138 entries,
append-at-top and concurrent-write-heavy (the mount has already silently welded a heading onto
line 9 once and eaten entries), and `CLAUDE.md` is large enough to hit the same mount-truncation
class. Neither is worth risking someone's revert path to save a splice.

---

## 1. Ledger entry — 5 PROD DB CHANGES today have no ledger revert path

⚠ These are **DB changes**, so `git revert` on the committed migration files unwinds **nothing**.
The repo files record already-live state. The DB revert paths below are the real ones.

Splice at the top of the 2026-08-09 section:

```markdown
### 2026-08-09 · SHIPPED (Cowork, DB-only — no push) — 5 prod DB changes: trust-board arms + MV cadence + the ed_med split

**1. `20260809145547_audit_20260809_retire_ufc_pct_stale_arm_add_precompute_freshness_arm`** — retired
`ufc_fmv_pct_stale_30d` (dated fuse: would have hit 100.0 ≥ breach 99.5 on 2026-09-03 with no
threshold remedy) and added **`trust_precompute_max_age_hours`** (breach 13) in its place; board
stays 38 arms. The new arm exists because `rpc-trust-health-precompute-refresh` died at 600.001s at
12:58Z and, being single-transaction with **no handler on Leg 7**, rolled back all 18 metrics
silently — the table still held 06:58Z values 8h later. breach 13 fires on two missed cycles
(~18.2h), not one (~12.2h), ahead of the 24h auto-999 cliff.
⚠ The retired metric must KEEP being written (the new arm reads max(age) over ALL rows).
**Revert:** re-apply migration `20260808163950`'s committed view definition, then
`ALTER VIEW public.v_rpc_trust_health SET (security_invoker = on);`

**2. `20260809145945_audit_20260809_halve_cadence_four_wasteful_hourly_mv_refreshes`** — jobids 235,
236, 237, 240 hourly → `*/2`. Measured 15,944 worker-s/day of which **6,201 produced nothing**
(runs killed at their 600s ceiling). This is the ledger's own "every 2 h = SAFE, ~50% saved" row;
the "cadence-cutting stays unsafe" line refers to the 6h row.
**Revert:** `select cron.alter_job(235,'7 * * * *');` and likewise 236 `'17 * * * *'`,
237 `'27 * * * *'`, 240 `'12 * * * *'`; restore the four `board_mv_refresh_watchlist` notes.

**3. `20260809200134` + **4.** `20260809200600` — the ed_med split.** `mv_topshot_perfect_mint_premiums_board`'s
`ed_med` CTE restricted to the edition set `perfect` already produces. Rows scanned
**396,644 → 6,202 (−98.4%)**; planner cost 176,993 → 100,355. Output-equivalent by construction
(restricting a GROUP BY's input to group keys cannot change a survivor's aggregate; the downstream
join is INNER). Corroborated 164/164 editions, 0 median mismatches, 1 count mismatch fully explained
by 7 rows ingested after the refresh stamp.
**Revert (DB):** recreate `mv_topshot_perfect_mint_premiums_board` with the UNRESTRICTED `ed_med`
CTE + `CREATE UNIQUE INDEX … (edition_id)`, then recreate view
`topshot_perfect_mint_premiums_board` + `ALTER VIEW … SET (security_invoker = on)` +
`GRANT SELECT … TO anon, authenticated, service_role` and
`REVOKE SELECT ON the MV FROM PUBLIC, anon, authenticated`.

**5. `audit_20260809_halve_cadence_pack_reality_top_ev`** — the fifth hourly MV refresh
(`15 * * * *` → `15 */2 * * *`), held back from #2 over an object-identity question now settled:
`topshot_pack_reality_top_ev` is a VIEW over the MV, and the MV is itself watchlisted, so the
binding gate is the same 8h arm. 24/24 successes, ~900 worker-s/day returned.
**Revert:** `select cron.alter_job(<jobid>, schedule => '15 * * * *');` + restore its watchlist note.

**Post-ship watch:** jobid 236 refresh duration. Pre-swap was BIMODAL on identical SQL (6.8s … 424s),
so the prediction is TAIL SUPPRESSION, not a lower median. First post-swap tick 43.4s — one sample,
inside the old range, proves nothing yet. Scheduled check `trig_012ouVnvSXcesVCw9BZtN4aB`
(2026-08-10 09:00 PT); it reports NOT-suppressed if any run ≥300s.
```

---

## 2. CLAUDE.md — two durable claims are now FALSE

**(a) Line ~196, the precompute bullet.** It currently reads:

> Each leg is isolated (a throw marks only its metric); the fn is single-transaction (a client
> timeout rolls back cleanly, no partial writes).

**The first clause is false and it is load-bearing** — it is why a partial failure looks survivable.
Only **3 of 7** legs carry `BEGIN … EXCEPTION` handlers (`fmv_sanity_flags`,
`pack_ev_publish_shortfall_pct`, board-liveness). **Legs 1, 2–5 (fmv coverage), 6 (panini) and
7 (serial supply) have none.** On 2026-08-09 the 600s kill surfaced in Leg 7 and aborted the whole
transaction — **all 18 metrics rolled back**, not one. Suggested replacement:

> ⚠ Only 3 of 7 legs are isolated (`fmv_sanity_flags`, `pack_ev_publish_shortfall_pct`,
> board-liveness); Legs 1, 2–5, 6 and 7 have NO exception handler, so a statement_timeout in any of
> them rolls back **all 18 metrics** (observed 2026-08-09 12:58Z, Leg 7, table left 8h stale).
> `trust_precompute_max_age_hours` (breach 13) now detects this. The fix is to split the fn into
> per-leg functions with their own cron entries — each gets its own 600s budget, a kill loses one
> metric instead of 18, and it creates the headroom to absorb the 25 live arms.

**(b) The `ufc_fmv_stale_hours` bullet** ends with:

> `ufc_fmv_pct_stale_30d` is unaffected and still live.

**Retired 2026-08-09** (`20260809145547`), before its 2026-09-03 permanent-red fuse. The board is
still 38 arms because `trust_precompute_max_age_hours` replaced it. ⚠ Its metric is still WRITTEN
(TRACK-only) and must stay that way.

Minor, optional: five pg_cron MV-refresh jobs moved hourly → `*/2` today (235, 236, 237, 240, and
`rpc-refresh-pack-reality-top-ev`); the active pg_cron job count is unchanged.
