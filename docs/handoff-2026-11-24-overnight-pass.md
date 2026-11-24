# Overnight autonomous pass — 2026-11-24 (~1:14 AM PT)

**Session:** Cowork cloud, laptop-VM blob:none clone + `.rpc-git-cred` push. **Mode:** genuine overnight (clock verified vs DB, below). Not frozen. Push AVAILABLE (dry-run exit 0). Lock was RELEASED (prior `cowork-20261123T090326Z-4836`, pushed a46e706c6); taken over as `cowork-20261124T090257Z-32270`.

**Verdict: GREEN. 0 production changes shipped (quiet-and-honest).** Every daytime-monitor inbox candidate since the last night pass was already resolved or fix-applied by the 11-23 Claude Code evening wave; the health vector is clean on every arm; the post-ship watch of the evening/overnight ships shows no regression. Nothing new was both low-risk and in need of shipping.

## Gates & clock
- **Clock, no skew:** shell `09:02Z` / device `09:02Z` / DB `now()` `09:05:48Z` / newest sale `09:03:10Z` / newest FMV `08:53:57Z` — all within ~3 min, so real local time is ~1:05-1:14 AM PT, a genuine overnight window.
- **Push route:** no `add_repo` tool this cloud session → laptop-VM `.rpc-git-cred` route. `git push --dry-run origin main` exit 0.
- **Collision gate:** `origin/main` = clone HEAD `0893574bf` at run start AND at the pre-write re-fetch — no advance, no human actively pushing. Ship budget untouched (0 of 4 used).
- **Stranded-output sweep:** no mount-only inbox files beyond the clone; no mount-only edits to `ledger.md` / `flow-ecosystem-watch.md`. Nothing to carry over.

## What was reviewed
- **Inbox drained — 6 filings since the last night pass (~11-23 09:10Z), all already handled by the 11-23 Claude Code evening pass:**
  1. `2026-11-23T1545Z` evening-pass open items — its held DELETEs (items 1-2) were applied attended this morning: `20261123154756` (retire two cadence bridges) + `20261123154821` (drop stale `ingest-topshot-challenges` suppression) + `20261123154924` (drop dead unscoped `check_set_completion`). All three have committed files. RESOLVED.
  2. `2026-11-23T1913Z` GHA schedule delivery stalled — SELF-CLEARED 11-23 2:08 PM PT (a `dead-lane-backstop-heartbeat` tick landed; watchdog read `delivering`). The #80 shed class; the watchdog working as designed. No action.
  3. `2026-11-23T2145Z` merge two split-suffix players — the split-player merge was applied 11-23 7:06 PM PT. RESOLVED.
  4. `2026-11-23T2206Z` panini_card_serials VACUUM statement timeout — FIX APPLIED `20261123231928` (job re-created as jobid 919 under `cron_heavy`, 600 s role default; command `VACUUM (ANALYZE) public.panini_card_serials`, no SET prefix). Verified tonight: job 919 exists, `active=true`, schedule `4 11,19 * * *`. **Scheduled-run verify still owed at the 11-24 11:04Z (3:04 AM PT) tick** — also covered by scheduled task `trig_01QRQpDVVWLhUfSgMCpvEX97` (Tue 7:40 AM). Carried as a pending read, not a queue item.
  5. `2026-11-24T0114Z` UFC wmc null-`edition_key` over the snapshot watcher — RESOLVED 11-23 7:45 PM PT: enrich-chain fix `f04a8cd` (unkeyed-only keyset paging, 140 s page timeout) deployed; both wallets walked to 0 unkeyed; optional UFC trust arm `ufc_wmc_null_edition_key_aged_rows` added (`20261124035113`). Verified tonight: `wmc_null_edition_key` snapshot list is EMPTY; the new arm reads `0 / ok` (breach_at 25).
  6. `2026-11-24T0252Z` create four scheduled checks + UFC enrich fix — scheduled tasks created by Cowork ~11-23 7:10 PM PT (`trig_01QRQpD…` VACUUM verify, `trig_01BaNKB…` 11-25 Top Shot lag, `trig_01QqtQF…` 12-07 gate week 4); UFC fix shipped (item 5). No residual action.
  - ⛔ Inbox left untouched (append-only); dispositions recorded here per the INDEX rules.
- **Dashboards:** none flagged broken/stale by the daytime monitor; no schema change tonight broke a dashboard query. None touched.

## Section 2 — health-drift triage (all GREEN)
Baseline: `rpc_ops_snapshot()` (generated 09:06Z) + direct catalog SQL.
- **Security:** `invariants []`, `anon_write_holes []`, `rls_off_base_tables []`, `secdef_anon_violations []`. Independently re-confirmed via the two direct catalog queries (public RLS-off count 0; anon/authenticated write-grant-on-RLS-off 0).
- **Trust health:** all 43 arms `ok`, `trust_health_breaches []`, no UNKNOWN. Notables: `ufc_wmc_null_edition_key_aged_rows` 0 (fix stuck), `topshot_wmc_null_edition_key_rows` 0, `fmv_sanity_flags` 0, `topshot_impossible_parallel_serials` 0, `panini_sale_field_mapping_shortfall` -73/ok, `candy_sales_stale_hours` 4.1/ok.
- **Stalled pipelines:** `[]`. **Sentinel:** `sentinel_ts_uuid_editions_48h` 0, `ts_uuid_dupes_created_24h` 0. **All drift arms** (search_path / txn-control / cursor-rewind / suppression-parked / suppression-count / cross-collection-mat) `[]`.
- **Pipeline fails 24h:** all low. `gha-schedule-watchdog` 17 (the #80 GHA-shed class — correct detector behaviour, self-cleared), `atlas-pack-market` 9, `atlas-pack-sales-ingest` 6, `pack-nft-identity` 4, `panini-collector-walk` 3, `pinnacle-wmc-render-id` 3 (2 are pre-fix derive timeouts, see post-ship watch), rest 1-2. `upstream` 0 except `allday-drop-windows` 1.
- **Pipeline alerts:** 0 HIGH/CRITICAL; 8 info, all Atlas/Dapper Cloudflare-403 base-rate + flow-rest moment-moved 400 — all designed, attributed-not-guessed outcomes. Freshness current on every lane.

### Post-ship regression watch (the 11-23 evening/overnight wave — CLEAN)
- **`pinnacle-wmc-render-id` 90 s derive budget (`20261124055144`, applied 05:51Z):** the 3 post-fix hourly :37 runs (06:37/07:37/08:37Z) all `ok=true`, `derive_error` null (derived 214/551/22). The 2 derive timeouts in the 24h window (01:37Z, 05:37Z) are both PRE-fix. Budget holds; not yet exercised past ~34 s so the raise itself is not yet PROVEN, but no timeout since the apply. Target metric: `derive_error` stays null on :37 runs.
- **Top Shot promote-gap fix (`20261123210830` + `20261123235536`):** on-chain sale-ingest p90 = **17.4 min** over the last 18h (n=1969, p50 3.9 min), down from 24.8 at the old every-20 gap and UNDER the 20-min escalation threshold the focus set. Promote drain `open_backlog` 0 / `still_unresolved` 0 across recent ticks; `skipped_recent_run` entries are the 20-min non-TopShot scopes gating correctly. The residual tail is indexer/chain, not the drain (which is the designed reading). Target metric: p90 ≤ ~20 min, backlog 0.
- **UFC enrich fix `f04a8cd`:** verified resolved (see inbox #5).
- **Migration parity:** CLEAN. All migrations applied to prod since 11-23 have a committed file BY NAME (`apply_migration` stamps its own version, so the committed filename's timestamp legitimately differs — 10 version-prefix mismatches all resolve to committed files). The one genuinely fileless migration earlier today (`scarcer_for_less`) was recovered 07:04Z (`588f2b8`).
- **Evening feature ships** (Candy 7Aru→OpenSea, Panini Scarcer-for-less / Autographs / serial-premiums tabs, My Teams series checklists, Pinnacle boards): prod deploy READY, no new runtime-error cluster on their routes.

### Vercel
- **Prod = `dpl_BtHh4gkniRa57gpKsC3Dc3zNr2Ku` (`21dd82b23`, feat 7Aru OpenSea) READY, rollback candidate.** Tip `0893574` (docs-only) CANCELED via `ignoreCommand` — expected. No ERROR deploy.
- **Runtime errors: 14 groups.** 13 are count 1-3 honest read-timeout degradations (get_player_top_sales, get_set_activity, pack-sniper/squeeze >8 s, collection-snapshot/wallet-summary RPC_READ_TIMEOUT, pack-detail, candy edition top owners, panini_deal_board_all, a market-cap `fetch failed`) — the same honest-degradation class as every night. The one standout — **Access Node Error (count 22, 3 users) on `/api/wallet-backfill`** — is a pre-existing wallet-backfill-family FCL transient (FCL mis-reads an upstream HTML/Cloudflare response on `rest-mainnet.onflow.org` as "not a valid REST node", the #122 522-class), first seen 11-11 and quiet since 11-23 21:27Z (~12 h). Not a regression, not actively firing, route-logic on an ingest-adjacent path → QUEUE/watch below.

### Overnight deltas (vs `metrics-latest.json`, prior = 11-23 09:10Z)
- **DB size:** 56,823 → **57,694 MB** (+871, routine growth).
- **FMV HIGH+MED:** nba 7,160 → **7,072** (-88); panini 23,464 → **24,162** (+698); nfl 1,817 → **1,748** (-69); pinnacle 930 → **931** (+1); candy 33 → **41** (+8 MED); golazos 1; ufc 0 (Flow side closed, market on Aptos).
- **Editions:** panini 55,857 → **56,706** (+849 continued backfill); nba 15,151 → 15,163 (+12); candy 21,522 → 21,512 (-10); nfl/golazos/ufc flat.
- **Trust breaches:** 0 → 0.

## Shipped
None. Quiet-and-honest; nothing new was both low-risk and in need of shipping, and the ship budget (4) was left untouched.

## Queued / needs decision
1. ✅ **`wallet_held_pack_value` CARRIED STALE — RESOLVED 11-22 ~9:15 AM PT** (`20261122170115`, per-wallet background cache; the 11-22 handoff and inbox INDEX already said so). Re-verified 11-24 ~7:45 AM PT (Claude Code, attended): job `rpc-wallet-pack-value-cache` `succeeded` every hourly :16 tick, 319 cached wallets, and `0xf77bf547fccf6656` refreshed 7:16 AM PT. Do not carry this again. Original text: **`wallet_held_pack_value` 20 s timeout on large pack wallets** (inbox 11-22 04:40Z) — **night 3.** The lane runs the whole pack-history classification; the biggest wallets (e.g. `0xf77bf547fccf6656`, 15,662 rips) cross the 20 s PostgREST ceiling (4 PostgREST 500s on 11-22). Honest-already (degrades honestly, no false claim). OFF-LIMITS for autonomous shipping: route-logic on a documented invisible-failure path + a hot file. The filer's three options are in `docs/handoff-2026-11-22-overnight-pass.md`. Trevor's / an attended Claude Code session's call.
2. **Access Node Error on `/api/wallet-backfill`** (new watch) — count 22 / 3 users over 11-11 → 11-23 21:27Z, quiet since. Likely FCL mis-reading a Cloudflare/HTML response on the Flow REST access node (#122 522-class). Not a live problem. If it resumes and clusters, the fix is route-logic (bound/guard the FCL access-node response shape) — off-limits for the unattended pass; QUEUE for an attended session.

## Pending reads (not queue items — time-gated)
- ✅ **VERIFIED 11-24 ~7:45 AM PT:** job 919 ran 3:04 AM PT, `succeeded`, and `last_vacuum` moved to 3:05:42 AM PT (`relallvisible` 1,079,928 of 1,082,125 pages). Inbox `2026-11-23T2206Z` closed. Was: **Panini VACUUM job 919** — the 11-24 11:04Z (3:04 AM PT) scheduled run `succeeded` AND `pg_stat_user_tables.last_vacuum` for `panini_card_serials` moves to it (a MAINTAIN gap would warn-and-skip and still read `succeeded`). Then inbox `2026-11-23T2206Z` is fully closed. Also covered by scheduled task `trig_01QRQpDVVWLhUfSgMCpvEX97`.
- **Read 11-24 ~7:45 AM PT:** 10 runs after the raise (10:37 PM → 7:37 AM PT) were all `ok=true` with `derive_error` null; the 2 derive failures on 11-24 UTC are both pre-raise (5:37 and 9:37 PM PT 11-23). Not yet PROVEN: `pg_stat_statements` max for the derive call is 29.5 s (224 calls), so no call has needed more than the old 30 s since the raise. Passive watch only. Was: **`pinnacle-wmc-render-id`** — a :37 run over ~45 s with `ok=true` would finally PROVE the 90 s budget binds.

## Failed / blocked / auto-reverted
None. No verification failure; production shipping was never hard-stopped (nothing was shipped).
