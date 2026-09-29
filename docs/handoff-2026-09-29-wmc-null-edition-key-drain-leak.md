# ⛔ CORRECTED 2026-09-29 (Claude Code, Trevor's box): the root cause below is WRONG — fixed in code

**Not a wallet-walk worker, and not phantoms.** The rows are **All Day moments written into the Top Shot cache by `/api/wallet-search`.**

- Every All Day collection-page load calls `/api/wallet-search` with `collection: "nfl-all-day"`, `limit: 50`. The route read the wallet's **All Day** ids, ran each through **Top Shot** lookups (the Top Shot metadata script answers "no nft"; Top Shot GraphQL, when up, returns a *different* moment that shares the number), then wrote the result into the **Top Shot** `wallet_moments_cache` as `edition_key NULL`, `set_name 'Unknown Set'`. That's the "50 per wallet" signature: one page per load.
- **Chain proof:** the 3:19 AM PT write for `0x6b939a05bfb81e11` had 5 of its ids probed. All 5 are **held in that wallet's All Day collection** and absent from its Top Shot collection. One id per wallet across all 36 wallets: **33 All Day-held**, 1 a real Top Shot moment, 2 moved.
- **Why the diagnosis below went wrong:** its 40/40 `no_nft` read checked only the **Top Shot** collection. It saw that the moment wasn't there, but never checked where it was. A moment id is unique only within a collection (#142).
- **The 37 rows Cowork filled are correct.** A chain read found all 37 held on Top Shot by the stored wallet (34/34 + 3/3), so they stay.
- **Fix shipped:** `app/api/wallet-search/route.ts`. An All Day id no longer reaches either Top Shot upstream or any Top-Shot-keyed read or write (wmc fill, wmc upsert, edition seed, acquisition read/classify). Test: `__tests__/wallet-search-allday-ids-never-touch-top-shot.test.ts`. It includes a positive control, and it fails 3/3 on the old code, which also put a Top Shot player's name on All Day rows.
- **Migration history reconciled:** both MCP-applied migrations were recovered byte-exactly (md5-verified) into `supabase/migrations/`. That includes the feeder. Parity needs a file for every applied name, so the "do not create a repo file" note below is overruled. The ad-hoc DROP is now recorded as `audit_20260929_drop_wmc_null_hydrate_feeder`, a no-op on prod.
- **Cleanup + monitor:** see the ledger entry of the same date.

---

# Handoff — TS wallet_moments_cache NULL edition_key: it's a wallet-walk PHANTOM-STUB bug (diagnosed 2026-09-29)

**Supersedes the first draft of this file.** The initial read ("the reconciler/drain can't keep up") was WRONG. Full investigation on 2026-09-29 (Cowork, after Trevor said "address and fix it") found the real cause. This documents the true root cause, what was safely fixed live, and what still needs worker-code changes Cowork cannot push.

## TL;DR
The `edition_key IS NULL` rows on Top Shot `wallet_moments_cache` are **phantom / mis-associated stub rows produced by the wallet-walk worker** — not unhydrated-but-held moments. The wallet-walk hands `upsert_wallet_moments` batches that include moment_ids the wallet **does not actually hold**, with no edition_key and `set_name='Unknown Set'`. Nothing downstream can resolve them because the moments aren't held (chain says so), aren't in `moments`, `nft_edition_map`, `topshot_ownership`, and mostly aren't in `sales`. The fix is in the **walker (worker/edge code)**, not the DB.

## Evidence (all measured 2026-09-29)
- **Page-of-50 signature.** Affected wallets carry ~48–50 NULL rows each — e.g. many wallets are exactly 50/50 NULL, or 100 total with exactly 50 NULL. That is a pagination boundary, not random churn: the walk emits a full page of ~50 unenriched/phantom stubs per affected wallet.
- **100% no_nft on chain.** Enqueued the standard read-only `borrowMoment` Flow script for a 40-row sample against their stored wallets. **40/40 returned `no_nft`** — the wallet's TopShot MomentCollection does not contain that moment id. The moment isn't there.
- **Not in any map.** Of the full 1,718 NULL cohort: 1,717 not in `moments`; 0 in `topshot_ownership`; 0 in `topshot_chain_moment_reads`; 16 in `nft_edition_map`; ~94 in `sales`.
- **Even the sale-resolvable ones are stale.** Of 95 rows resolvable from a recorded sale, only **37** had the wmc wallet = the moment's most-recent buyer (still-held); **21** had since sold to a *different* wallet (phantom); 37 had no buyer_address on the latest sale.
- **The stubs are actively re-supplied.** `upsert_wallet_moments` prunes rows for a wallet not re-seen in 5 min, then re-inserts what the walker passes — so a plain DB cleanup would be re-populated on the wallet's next walk. The writer faithfully stores whatever the walker sends; the bug is upstream of it.
- Started ~2026-09-07 (NULLs by created-week: ≤08-31 ~1–2/wk → 09-07: 34 → 09-14: 550 → 09-21: 750 → 09-28 partial). Something changed in the walk set/paging around then.

## Why the existing pipeline can't self-heal these
The whole moment-hydration pipeline (`topshot_moment_hydrate_dispatch`, `_dispatch_head`, `hydrate_topshot_moments_from_wmc`, `v_moments_needing_hydration`) feeds ONLY off `moment_acquisitions` where `acquisition_method='pack_pull' AND acquisition_confidence='verified'`. And `reconcile_wmc_edition_key_from_moments` (cron jobid 587, healthy) only fills a wmc row once its moment is in `moments` AND a sale/subedition corroborates. A wallet-seen, non-pack-pull, never-sold, not-actually-held moment matches none of those, so it stays NULL forever.

## What was fixed LIVE this session (safe, reversible, DB-only)
- **37 ownership-corroborated rows resolved.** Filled `edition_key` (+ serial) for the 37 NULL rows where the moment's most-recent sale bought it TO the stored wallet with no later sale — i.e. provably still held. Impossible-serial guarded, logged to `public.audit_20260929_wmc_null_key_backfill` (37 rows). **Revert:** `UPDATE wallet_moments_cache w SET edition_key=NULL, serial_number=NULL FROM audit_20260929_wmc_null_key_backfill a WHERE w.id=a.id;`
- **NOT touched:** the other 1,681 NULLs. A first-pass backfill filled 95 from sales, but 58 were **reverted** because they were stale/uncorroborated (the wallet no longer holds the moment) — filling them would have let the fmv-populate cron attach dollar value to holdings the wallet doesn't have, overstating portfolios. Only the 37 corroborated stand.
- **A chain-read feeder was built, tested, and dropped.** `topshot_moment_hydrate_dispatch_wmc_nulls(int)` was created to enqueue chain reads for the NULL cohort; the 40-row test proved 100% no_nft (the moments aren't held), so it was the wrong fix and was `DROP`ped. **No cron was scheduled.** Net-zero.

## What still needs doing (worker code — NOT pushable from Cowork — + review)
1. **Fix the wallet-walk worker (root cause).** Find why it emits ~50 stubs/wallet for moments the wallet doesn't hold. Prime suspects: a pagination offset bug (page N's ids stored under the wrong wallet), or a moment-listing source returning phantom/stale ids, or enrichment failing open (emit a stub instead of skipping). The walk should not persist a wmc row for a moment it cannot confirm the wallet holds.
2. **Optional writer guard.** Consider having `upsert_wallet_moments` skip/quarantine rows with NULL edition_key it cannot resolve — carefully, so a genuinely-held-but-not-yet-enriched moment isn't dropped.
3. **Clean up residual phantom stubs** AFTER the walker is fixed (before that, they repopulate). They're NULL-key so already invisible to edition-keyed reads, but they violate the wmc contract and can render as "Unknown Set" ghosts in raw portfolio views.
4. **Add a monitor.** `v_rpc_trust_health` arm `wmc_null_edition_key_count` (TS-scoped; EXCLUDE Pinnacle — its editions live in `pinnacle_catalog`, never in `editions`, so its ~41k wmc rows are structurally "orphan" and not a defect). Breach above the post-cleanup steady state so a recurrence pages.

## DB migration-history note (reconcile the repo)
Two migrations were applied via the Supabase MCP this session; no repo migration files exist yet:
- `audit_20260929_wmc_null_key_backfill_from_sales_and_map` — created the audit table + backfilled (58 of 95 later reverted via ad-hoc SQL; 37 stand). Live and intended to keep. Formalize as a repo migration if you want history parity (note the audit table now holds 37 rows).
- `audit_20260929_add_wmc_null_hydrate_feeder` — created the feeder function, which was then **DROPPED**. A reverted dead-end. **Do NOT create a repo migration file for it** (the function no longer exists).

Ledger: `docs/overnight/ledger.md` (2026-09-29, two entries — the read-only finding and this fix pass).
