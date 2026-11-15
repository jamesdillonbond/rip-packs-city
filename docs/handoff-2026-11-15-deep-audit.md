# Handoff — 2026-11-15 monthly deep audit residue

From the scheduled Cowork deep-audit pass (report: `docs/audits/deep-audit-2026-11-15.md`). Everything below was found and verified read-only but NOT shipped. Each item has the evidence, the proposed change and a revert path. All times are PT.


> **Status update 2026-11-15 ~8:15 AM PT (Claude Code cloud, autonomous session):**
> - **#4 Candy holders — ✅ DONE** (`ef0a73381`): paged read, all 1,316 holders in the 7:37 AM PT snapshot, no cap notice.
> - **#2 D2 panini-premiums — ✅ FIXED** (`070bd9eaf`): page read budget 8 s → 25 s; every regeneration since 10-14 had died at 8 s. Live DOM 201 rows, no failure copy. The matview remains the structural fix (optional). **`/panini-blockchain/market` — left as is:** re-measured in a quiet hour, 1 of 3 renders 503'd; its board read has only ~50 production calls in pgss, so a refreshed matview would cost more than the reads it saves.
> - **#3 D4 `/api/analytics/health` — ROOT CAUSE FOUND, migration STAGED, not applied** (`apply_migration` blocked by an unanswered confirmation): the `sales_2026` leg of `analytics_pipeline_health()` has no plain `sold_at` index and walks every 24 h row via the pkey (12,591 buffers; 4.3 s cold vs its own 5 s timeout). Adding `AND price_usd > 0` uses `idx_sales_2026_fmv_recalc_window` → 5 buffers; equivalent (0 non-positive sales in 7 d). One-line body change on 20260925060717's body.
> - **#6 C3 — the proposed UPDATE cannot run as written:** `pack_ev_latest` is a VIEW (relkind `v`); the 66 rows come from its base history. Not exposed. Re-scope before acting.
> - **E-2 — ✅ DONE** (`ef0a73381`): `total_is_capped` beside `total` at all four sites. **E-3 `esc()` — ✅** both notify escapers add `'`. **E-3 `#E03A2F` in FmvHistoryPlot — no change:** both carry the `brand-exception` comment (recharts SVG cannot resolve CSS vars). **E-3 zero-reference exports — not removed** (low value).
> - **#5 C1 slug trailing dash — NOT a code defect on its own:** `slugifyName` keeps edge dashes on purpose to round-trip the SQL resolver's expression; changing it means changing the resolvers too. The per-person merges are DB work (#139 pattern).
> - **F-1:** no live doc quotes the 44-row count; nothing to change.


> **Status update 2026-11-15 ~10:06 AM PT (same session, after Trevor's approvals):**
> - **#2 D2 market page — ✅ mitigated** (`19da231a6`): the Market tab retries a cold-read 503/504 once. With panini-premiums fixed, **R152 is resolved in the register**.
> - **#3 D4 `/api/analytics/health` — ✅ APPLIED** `20261115172732` (read back 20 ms / 2.4k blocks, was 4.3 s).
> - **Daytime-monitor candidate 2, hybrid-custody timeouts — ✅ APPLIED** `20261115172736` (90 s function timeout).
> - **#5 C1 (R153) — Luis Garcia/García ✅ DONE** (`20261115180005` + `20261115180236`, Trevor's rename call; residual = known-issues #258). **The 6 spelling merges + 48 Panini country duplicates are APPROVED and WITH COWORK** (SQL editor; the connector dialog failed 5×) — inbox `2026-11-15T1635Z`.
> - **#248 (not in this audit, same thread) — job 617 daily** `20261115175130`; final read 11-16 (focus.md steer).

## 1. A-1 · P2 · Handle squatting through resolve-and-associate (security, decide first)

`POST /api/profile/resolve-and-associate` takes a Top Shot username or address from the body, saves the wallet with **no ownership proof**, then `claimUsernameFromTopShot` (`lib/profile/claim-username.ts:45`) upserts `profile_bio.username` from it, first come first served. `c082fea78` (11-03) widened it: pasting an address reverse-resolves that wallet's username into a handle. So a signed-in stranger can take a real collector's handle and appear as them on `/profile/<handle>`, the trade block and trophy boards. Not a data leak: private routes key on `user.id` (#176).

- Canary today: `select count(*) from (select wallet_addr from saved_wallets group by 1 having count(distinct user_id) > 1) x` → **0**. No squatting has happened yet.
- Proposed: in `resolve-and-associate`, call `claimUsernameFromTopShot` only when the wallet is proven for `user.id` (`verifyClaimProof` / a verified-wallet row); otherwise leave the handle to `/profile/edit`.
- Product question: a first-run handle that waits for proof slows onboarding for honest users. Trevor's call between "proof required" and "claim, but release on a proven counter-claim".
- Revert: revert the commit.

## 2. D2/D3 · P2 · Panini reads time out at the 8 s client cap

- `/insights/panini-premiums`: failed cold 2 of 2. `panini_serial_premiums` bitmap-scans ~30.5k blocks of `panini_sales` (90 d): 7.6 s cold, 1.6 s warm direct, 4.4 s average / 18.7 s worst over 1,448 PostgREST calls. Proposed: a matview refreshed hourly (page is `revalidate = 3600`), anon-unreadable with a SECDEF or service read, following `rpc-insights-qa`. Revert: drop the MV, restore the view read.
- `/panini-blockchain/market` default `?sort=price_asc`: 4 of 8 curls returned 503 at ~8.3 s (1:21–1:27 AM). `panini_market_board` reads take 0.9 s direct, 4.2 s average / 28 s worst via PostgREST. This was measured under load (wmc autovacuum running), so first re-measure in a quiet hour; if it is still > 3 s, narrow the columns or precompute.

## 3. D4 · P2 recurrence · `/api/analytics/health` 500s

`analytics_pipeline_health` has its own 5 s timeout: 163 ms direct, 1.7 s average / 5.0 s worst over 4,349 calls. 500s seen 9:41 PM, 11:17 PM, 1:18 AM, 1:25 AM. Same class as the 11-07/08 "analytics group stalls". The badge says "Status unavailable", which is honest. Fold into that open item.

## 4. Candy holders ranking is capped at 800 of 1,316

Shipped today: the banner now says the list is capped instead of calling it a load failure. The ranking itself still stops at 800, because PostgREST clamps at 1000 and `CandyBoardClient` caps the table at 800. To show all holders, page the read (`.range()` with a unique-key `.order()`, e.g. `serials desc, wallet_address`) and raise the client cap.

## 5. C1 · P2 · Candy/Panini player identity splits

These are 5 Candy pairs and 2 Panini pairs whose names differ only by punctuation or accents:

- Cal Ripken Jr / Jr.: `cal-ripken-jr` shows 5 of 16 editions and `cal-ripken-jr-` shows 11 of 16. That is two live URLs, and one ends in a dash.
- C.J./CJ Abrams
- Jasson Domínguez/Dominguez
- Luis García/Garcia: ⚠ several MLB players share this name, so check it against MLB first.
- Yordan Álvarez/Alvarez
- P.J./PJ Washington Jr.
- Wang Zhi-zhi/Zhizhi

Separately, `mackenzie-gore` (a double-space variant sharing one slug) shows 5 of 8 editions. Merge each pair per person using the #139 pattern (alias in `player_aliases`, editions re-pointed, 301 from the dead slug). Also, `slugifyName` keeping a trailing dash is a code defect of its own.

## 6. C3 · P2 · 66 Top Shot `pack_ev_latest` residue rows

These rows have `gross_ev > 0` at `fmv_coverage_pct = 0` (April challenge-reward rows, `dist_id` NULL, one with `is_positive_ev`). Not exposed: every public reader applies the 72 h and availability bar. Proposed: `UPDATE pack_ev_latest SET gross_ev=NULL, pack_ev=NULL, is_positive_ev=false WHERE collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd' AND fmv_coverage_pct=0 AND gross_ev>0` after archiving the rows.

## 7. C4 · alarm tuning · `candy_sales_stale_hours` BREACH is the #257 history walk

The ">50 newly parked in 48 h" arm counts 2,045 deliberate `queued_collections_walk` rows. `candy-sales-indexer` ran 8 of 8 OK with 281 rows in the last run. It should drain within about a day; if `unresolved_open` is not falling by 11-16 evening, exclude that skip reason from the arm.

## 8. Smaller items

- **E-1:** the edition page (`revalidate = 600`) ISR-caches `<EditionUnavailable/>` on a failed read. Add it under known-issues #249, and preview-render before changing it.
- **E-2:** concierge tools label a capped row count as `total` (`app/api/support-chat/route.ts:2826, :6185`; `lib/concierge/candy-boards.ts:250`; `lib/concierge/allday-boards.ts:172`). Rename the field to `returned` or add `total_is_capped`.
- **B2:** once #190 closes, remove the two `up_to_date` no-op stage crons from `vercel.json` (`47 * * * *` and `?lane=provenance` at `52 * * * *`).
- **A-2:** three new `function_search_path_mutable` warnings (`alert_sub_is_exact_serial`, `recent_low_usd`, `topshot_league_for`). Accept like R142 unless one sits on a hot path; pinning stops inlining.
- **E-3/E-4 hygiene:**
  - 7 zero-reference exports added since 10-15: `resetCandyCollectionsCache`, `candySetByAddress`, `candySetOf`, `INDEX_DEAL_COLLECTIONS`, `DEAL_MODES`, `iaGroup`, `PRIVATE_FORWARDER_PUBLIC_PATH`.
  - 6 new local `esc()` HTML escapers; the ones in trade-block and trade-room notify skip `'`.
  - 15 `safeEqual` copies in workers.
  - 2 bare `#E03A2F` strokes in `components/entity/FmvHistoryPlot.tsx:117,120`.
- **F-1:** traction docs should quote email subscribers as `verified AND unsubscribed_at IS NULL` (= 1), not the 44-row table count.
- **Register housekeeping:** E5's list still carries the retired UFC routes `ufc-enrichment-drain` and `wallet-backfill-ufc`. The Candy wmc VERIFIED-CLEAN row needs re-baselining (now a 1.37 M-row census).
