# Handoff — 2026-09-26 daytime autonomous pass (Cowork, ~7:55 AM → ~12:55 PM PT)

> ⚠ The push limitation below is specific to **this cloud session**: its git proxy does not have the repo in its authorized set. Trevor's machine and Claude Code push normally via Git Credential Manager. **Every change in this pass was pushed to `main`** (through the laptop VM + `.rpc-git-cred`, path 1), so nothing is waiting to be committed.

## Health verdict — GREEN (checked ~8:00 AM, re-checked through the pass)
- Security: `check_public_security_invariants`, anon write surface, secdef anon exec, search_path drift, WHEN OTHERS timeout blind: all `[]`. 38/38 trust arms ok; `trust_precompute_max_age_hours` 6.0 (breach 13).
- pg_cron 24 h: 10,209 succeeded, 0 failed. Pipeline failures: only the known chronic ones (atlas-market-feed 19/719 Cloudflare, sync-nba-projections 8/8 = #8 shelved, small transients).
- Stalled: only `topshot-active-listings-ingest` (1,544 min) — fixed for today by hand, see below. After: `detect_stalled_pipelines()` = `[]`.
- Vercel 24 h: chronic groups only (DEP0169, All Day GQL 403 → RPC fallback). One new `/api/market` 22P02 on a slug `collectionId` — the concurrent Claude Code session shipped the fix (`1e248c9c2`) minutes before mine; I dropped my duplicate.
- `pg_net_http_422` (high) + `pg_net_http_403` (critical) rows: 422s are GraphQL schema probes (`filters.nfts.like/match/...`, `buyer`, `storefront_address`) — self-inflicted by a session probing a schema, case (b) of that arm; 403s are Cloudflare "Just a moment" samples. Not outages.
- Golazos: 0 sales since 09-12 is REAL dormancy — the storefront reconcile's 3,338 live listings show `closed 0 / vanished 0`, and the studio index also wrote 0.
- 18 key pages + 30 random sitemap URLs: 200, `index, follow`, self-canonical. Security headers present (HSTS preload, CSP, XFO DENY, nosniff).
- #128 drain: Top Shot `pull_value_usd = 0` 53,134 (09-24) → **38,134** (09-26 ~9:40 AM) — on track for the ~10-01 re-read.

## Shipped (all on `main`, each with a ledger entry and revert path)
1. **Top Shot underpriced-#1s board refreshed by hand.** The laptop's Windows Task Scheduler arm has logged nothing since 09-25 6:13 AM PT. A dry run from the laptop VM in browser mode proved Atlas still passes (landing 200). ⚠ Corrected later: the task was fine — the laptop had been dark; it ran by itself at 9:13 AM PT. Ran 13 `CHUNK_MODE` slices (1,006 targets, 392 upserted) + one `{final, deactivate}` POST (12 deactivated).
2. **`candy_pack_market` escrow fix** (`20260926154232`): collector_wallets 63 → 71.
3. **#148 closed**: `?strict=1` on `/api/profile/top-moments` + `/hero-moment` (404 `owner_not_found`); unmounted profile `CostBasisCard` deleted. (Note: `/api/profile/*` is auth-walled by `proxy.ts` — a signed-out call 307s to `/login`.)
4. **#144**: `ingest-topshot-atlas-pool` reads the key from the Authorization header only — deployed v37 via edge-fn-deploy, `?key=` now 401s, pin test added.
5. **#142 re-key applied** (`20260926162443`): 77 Top Shot sales moved to the one edition their NFT sold under; backup `audit_20260926_i142_sales_rekey`; revert is one UPDATE.
6. **#145 residual**: `wallet-backfill-candy` writes the wallet's escrow-held LISTED cards back to it (3 commits: first cut, sized for a 487-listing seller, 429 retry). **Live positive control:** seller `8DtPD…yNmX` → 62/62 listed cards now under the seller, ok=true, 7.9 s.
7. Edition page copy: "1 sale", not "1 sales". ESLint ratchet re-baselined 703 → 701.
8. **Panini dead links**: an internal-link crawl (14 key pages → 530 links) found 42 × 404, all from the `PopularOnCollection` fan-out on `/panini-blockchain/overview` and `/market` (Panini has no entity pages). The fan-out now renders only for a collection in `lib/collection-slug` — verified live: Panini 0 entity links, Candy's 41 intact. A second-level crawl (585 more links) found no real 404s.

Checks run before pushing code: full vitest suite (4 shards, 18.8k tests) green twice, `tsc` 0, `lint:ratchet` ≤ baseline, new tests fail against the previous code.

## Needs Trevor
- ~~The laptop's scheduled task~~ — **CORRECTED at the 12:05 PM closing check:** it ran on its own at 9:13 AM PT (393 rows, browser mode). The 25 h gap was the laptop being off/asleep; nothing to fix.
- **Rotate `ATLAS_POOL_INGEST_KEY`** (#144) — edge secret + your user env var.
- Standing: #22 (GitHub Support GC + rotate), #64 (Panini bridge), #140 (thin-edition FMV window), `wrangler deploy` of pack-events-ingest (#134/#123), `enrich-ufc-wallet` CLI deploy.

## Watch
- 7:00 PM PT scheduled task "verify Candy escrow remap after walk" (#145 falsifier). The per-wallet path and the nightly walk now agree on attribution; `purge_candy_wmc_ghost_rows` keeps the newest row per card.
- `wallet-backfill-candy` run rows: `escrow_listed_error` / `escrow_listed_capped` should stay null/false.
- Migration parity should stay green (both migrations' files landed within minutes).
- Housekeeping: 16 `cowork-20260926-*.patch` files sit in the laptop repo root (gitignored); delete them when convenient.
- Crawling with 4–8 parallel requests from one IP produced sporadic `000`/SSL resets that all returned 200 on a sequential retry — a crawl artefact (proxy/edge), not a site fault.

## Closing check (~12:06 PM PT)
- Security [], stalled [], 0 pg_cron failures in 3 h, CI green on `a14d7ff47`.
- Set-page statement timeouts (10:17 / 10:27 AM PT, during the concurrent session's Pinnacle set migrations) did not recur.
- `wallet-backfill-candy` latest run: ok, 62 escrow-listed cards written.

## Continued pass (~12:10 → ~12:50 PM PT) — Top Shot "lowest ask" was false on ~1,230 editions (#149)
- **Found:** the Tre Jones Base Set page (124:5108) said "lowest ask at $20.00" over 69 open listings from $0.20. `sync_edition_offers_from_atlas()` took the floor from listings re-observed in 24 h; the Atlas firehose only re-reports CHANGED listings (#85), so cheap quiet listings age out, and an edition with no 24 h listing kept its old floor forever.
- **Shipped** (`d23b32d1e`, 2 migrations, DB-only): `20260926192206` NULLs a 24 h floor undercut by an open listing (seen ≤ 30 d) under half of it; `20260926192947` applies the same test to the STORED floor. First ticks: `undercut_nulled 239` (12:26), `stale_undercut_nulled 994` (12:31), tick 2.7 s ok. Live page now reads "worth ~$0.21 … recent-sale low of $0.20". Pin extended, two planted defects caught.
- **Measured after:** 801 of the 1,234 NULLed editions were edition-verified within 7 d and in every one the cheap listing was re-seen by that verification — the undercuts are real, the old floors were false.
- **Open decision (#149):** publish the cheapest listing a verification re-saw within N days (with its age) instead of NULL, and/or give undercut-NULL editions priority verify slots. Not shipped autonomously (changes what the ask means / the probe budget).
- **Decision taken (~1:05 PM PT, "do what you think is best"): priority re-verification.** A hand probe of 30 undercut-NULL editions found 20 % of "open" listings older than 24 h were actually closed, and every edition that answered was re-priced correctly from the verified book. New lane `rpc-ts-edition-verify-undercut` (3 Atlas edition probes every 5 min, `20260926200238`); first run pool 1,220, ok. Watch `extra.pool` fall over ~1.5 days and the edition-probe 403 rate stay ~6 %.
