# Handoff — Panini full-catalog enumeration + Candy offer capture (2026-07-19)

## Context

Cowork shipped live this session (already applied to prod, nothing to re-do):

- **Candy DB parity** — migrations `audit_20260719_candy_mlb_metadata_backfill`, `audit_20260719_candy_wmc_metadata_denorm`, `audit_20260719_candy_wmc_purge_ghost_owner_rows`, `audit_20260719_candy_wmc_ghost_purge_selfheal` (+ pg_cron `rpc-candy-wmc-ghost-purge`, jobid 201).
- **Panini measurement** — migration `audit_20260719_panini_coverage_audit_view` (view `public.panini_coverage_audit`).
- **Code** — commit `67b46fb` (Candy ME sales indexer armed + 3h Vercel cron; CI unit-test repair). CI green on `main`, all 5 jobs.

This handoff covers the two things Cowork **could not** finish: work that needs the logged-in residential Chrome/runner (Panini), and a new ingest route that wants real iteration against a live paginated API (Candy offers).

Full detail + revert paths for everything above: `docs/overnight/ledger.md`, 2026-07-19 entries.

---

## Item 1 (HIGH) — Panini: replace listing-gated discovery with a real catalog enumeration

**This is the #1 Panini go-live blocker.** It is a correctness problem, not a throughput one.

### Root cause (established this session, don't re-derive)

`scripts/ingest-panini-runner.mjs` enumerates editions from the grid response of the GraphQL operation **`getMarketPlaceList`** (see the comment block at lines ~52-61). That operation returns *marketplace listings*, so an edition only ever enters `panini_editions` once it has been **listed for sale**. Discovery is therefore listing-**gated**, not merely listing-biased.

Measured evidence (from `panini_coverage_audit`, 1,647 discovered editions):

| Parallel | avg mint cap | % of 474-player checklist discovered | % of pulled copies currently listed |
|---|---|---|---|
| Base Prizms Red | 124 | 64.1% | 5.7% |
| Base Prizms Silver | 259 | 45.4% | 3.6% |
| Base Prizms Gold | 10 | 24.3% | 26.7% |
| Base Prizms Black | 1 | 8.4% | **100.0%** |
| Base Choice Nebula | 1 | 7.0% | **100.0%** |

The decisive tell: for the two 1-of-1 parallels, **100% of discovered copies are currently listed** (40/40 and 33/33). That is impossible for an unbiased sample — we can only ever see a 1-of-1 while its single copy happens to be for sale. Coverage degrades monotonically with scarcity, so the index is thinnest exactly where squeeze/scarcity analysis is most interesting.

Bucketed across all 55 families: `listing_gated` 12 families / 102 editions, `heavily_biased` 17 / 459, `partial` 16 / 318, `broad` 10 / 768. Only **47% of discovered editions sit in a trustworthy-coverage bucket**.

### Approaches already ruled out — do NOT re-attempt these

1. **Crafted GraphQL requests.** `POST https://nft.paniniamerica.net/onepanini` returns **HTTP 426 `{"status":426,"message":"Invalid request"}`** for a plain `fetch` with `credentials:'include'`, even from an authenticated page context. Verified live 2026-07-19 in Trevor's logged-in Chrome. The endpoint needs headers the SPA adds.
2. **GraphQL introspection.** Blocked by the same 426.
3. **In-page `fetch`/XHR override.** Already documented as non-working in the runner (lines ~41-43): the app closes over `fetch` before injection. Re-confirmed. Only Playwright's `page.on("response")` (CDP/network layer) works — which is what the runner already does.
4. **Offline psku construction.** The psku is `packcard-<setId>_<parallelSetId>_<cardId>_<playerId>` — **note the runner's comment at line ~36 has playerId and parallelId swapped**; field 2 has 54 distinct values (= the 54 set names), field 4 has 474 (= the checklist players). Card IDs *are* contiguous ~474-500-wide blocks per parallel set, and blocks tile adjacently (Base Prizms Blue starts at Red's max + 1). That looked like it made enumeration free, but:
   - The URL requires the **exact** psku. `.../packcard-2332_486965_12679054_999999.html` (valid card, mangled playerId) renders an empty "Panini Product" shell with no card data. Verified live.
   - `player_id` is **not** a fixed function of `card_id` (41 distinct offsets within Base Prizms Red; only 13 of 54 parallels have a constant offset).
   - Rank-alignment also fails: only **3 of 15** parallels with ≥20 rows are perfectly co-monotonic; Red has 271/304 rank mismatches (Spearman 0.938).

   So card_id contiguity is real and useful as a *validation* signal, but it cannot generate valid pskus on its own.

### What to actually do

**Step 1 — find a non-marketplace enumeration (the whole ballgame).** On the residential box with the logged-in Chrome, drive the SPA and capture `/onepanini` request bodies at the CDP layer (same `page.on("response")` mechanism the runner already uses, but log the **request** payloads too — `request.postData()`). Look for an operation that enumerates a **cardset/checklist** rather than a marketplace. Concretely worth exercising in the UI while capturing:
   - any set / checklist / "collection" browse view (not the marketplace grid);
   - the marketplace grid with a **cardset filter** applied — capture whether `getMarketPlaceList` accepts a cardset/parallel argument and whether it returns unlisted rows;
   - a card detail page — `getCardMarketStats` is per-card; check whether a sibling operation returns the card's *set siblings*.

   The decision: **is there any operation that returns cards independent of listing status?**

**Step 2a — if yes:** repoint enumeration in `scripts/ingest-panini-runner.mjs` from the `getMarketPlaceList` harvest onto that operation. Keep the existing per-psku detail walk (that part is fine and already yields correct supply stats). Expected result: `panini_coverage_audit.coverage_flag` moves off `listing_gated` for the scarce families and `pct_of_base_checklist` climbs toward 100.

**Step 2b — if no:** this is a genuine platform limitation, not a bug. Then:
   - Record it in `docs/overnight/ledger.md` under a clear heading so it is never re-investigated from scratch.
   - Coverage still improves monotonically on its own — `panini_editions` retains rows permanently, so every card that is *ever* listed is captured forever. **Now verified rather than assumed:** `created_at` is a true first-seen stamp (never updated), 1,383 rows have been re-observed since insert, and 13 zero-listing editions persist without being dropped. `panini_coverage_audit` tracks the drift via `first_seen_24h`.
   - **Any public Panini surface must then carry an explicit coverage disclosure** — same honesty stance as the 07-18 Sold-tab lower-bound note. Do not let the squeeze board imply completeness it doesn't have.

**Files:** `scripts/ingest-panini-runner.mjs` (enumeration section, ~lines 120-190). Ingest contract and normalizer are unchanged: `app/api/cron/panini-ingest/route.ts`, `lib/chains/panini/ingest-normalize.ts`.

**Revert:** `git revert <sha>` — runner-only, no schema change. The runner is scheduled by `scripts/panini-schedule.bat` (Windows Task Scheduler, every 4h); a bad runner degrades to "no new rows", never to bad rows, because `panini-ingest` is upsert-by-psku.

**Verify:** after one full run, `SELECT coverage_flag, count(*), sum(discovered_editions) FROM panini_coverage_audit GROUP BY 1;` — `listing_gated` family count should fall. Baseline to beat: 12 families / 102 editions listing_gated, 1,647 total.

### Do NOT do yet

**Do not surface the five built-but-unrouted Panini boards** — `panini_deal_board` (136 rows), `panini_player_board` (552), `panini_nation_board` (71), `panini_special_serials_board` (1,012), `panini_pack_ev_board` (2), `panini_pack_ev_model` (1). They all read the same listing-gated index, so shipping them now multiplies one completeness defect across five public surfaces. `panini_special_serials_board` is the worst case — special serials live disproportionately in the 7-24%-covered scarce tail. Fix coverage first; the surfacing work is cheap afterwards (`app/insights/panini-squeeze/` page + `app/api/public/insights/panini-squeeze/route.ts` + `app/api/og/insights/panini-squeeze/route.tsx` is a complete 3-file template).

**Panini go-live stays Trevor's call** — one line, `proxy.ts:127`. Deleting it un-gates page + JSON + OG together. Go-live also wants the `panini-squeeze` slug added to `INSIGHT_ROUTES` in `lib/sitemap-data.ts`, an `/insights` hub card, and dropping `robots: { index: false }` from `app/insights/panini-squeeze/layout.tsx`. Don't do any of that without Trevor saying so (standing no-promo-until-launch-ready rule).

---

## Item 2 (MED) — Candy: capture Magic Eden offers as an honest best-offer signal

### Why

Candy has **zero price signal**: `sales` 0 rows, `fmv_snapshots` 0 rows, `wmc.fmv_usd` 0/25,375, and Magic Eden `listedCount` is **0** (quest-hold rule suppresses listings). The only live market signal is **bids**, and `app/api/candy-sales-indexer/route.ts` deliberately discards them (`SALE_TYPES` excludes `bid` — correct, they are not sales). Until listings open, a bid-derived best-offer is the only way a Candy surface is non-empty.

### Verified API shape (probed live 2026-07-19, no auth needed)

Symbol `2026_mlb_base_series_icons_candy_digital`.

- `GET /v2/collections/{symbol}/stats` → `{"symbol":"...","listedCount":0}`
- `GET /v2/collections/{symbol}/listings` → `[]`
- `GET /v2/collections/{symbol}/activities?offset&limit` → bid **events**, incl. `{signature, type:"bid", tokenMint, buyer, price (SOL), blockTime}`. Events, not standing state — a bid here may already be cancelled.
- `GET /v2/tokens/{mint}/offers_received` → **current standing** offers: `{pdaAddress, tokenMint, auctionHouse, buyer, price, tokenSize, expiry}`. Per-token, so unusable across 25,375 mints.
- `GET /v2/wallets/{address}/offers_made?offset&limit` → **current standing** offers for one bidder, same shape. This is the efficient lane.
- `GET /v2/mmm/pools?collectionSymbol=...` → `{"results":[]}` (no AMM/pool bids to merge).

### Design

1. Walk `activities` for `type:"bid"` over a recent window → distinct `buyer` wallets (bidding is currently concentrated; one sweeper bot dominates).
2. For each bidder, page `offers_made` and keep rows whose `tokenMint` is a known Candy mint (`wallet_moments_cache.moment_id` where `collection_id = '209ade70-32c5-4470-bc7c-4793d660f713'`).
3. Upsert on `pdaAddress`; treat absence on a later sweep, or `expiry` in the past, as offer-gone.
4. Aggregate best offer per edition, carrying **bidder diversity** (distinct buyers, offer count) alongside the max price.

Suggested route `app/api/ingest/candy-offers/route.ts`, mirroring the auth shape now in `app/api/candy-sales-indexer/route.ts` (`authed()` accepting `INGEST_SECRET_TOKEN` **or** `CRON_SECRET`, GET + POST, `after()` + 202) so a Vercel cron can drive it. `lib/chains/solana/das.ts` already exports `solUsd()` for SOL→USD.

### Honesty constraint (do not skip)

Surface this as **"best offer"**, never as FMV, and never fold it into `fmv_snapshots`. Current bids are ~0.003-0.04 SOL (roughly $0.50-$6) from a single sweeping wallet — that is a lowball bid floor, not a fair value. Carry the distinct-bidder count through to the view so a surface can suppress or caveat a single-bidder signal. This matches the existing stance that ASK-only inputs are labelled honestly and never presented as sales-derived value.

**Revert:** `git revert <sha>` + `DROP TABLE` the new offers table + remove the `vercel.json` cron entry.

**Verify:** `pipeline_runs` shows the new pipeline `ok=true`; row count in the offers table > 0; spot-check one `pdaAddress` against `GET /v2/tokens/{mint}/offers_received`.

---

## Item 3 (LOW, informational) — Candy wallet backfill needs no cron

`app/api/wallet-backfill-candy/route.ts` has no in-app caller. **This is correct, do not wire a cron.** The daily `app/api/ingest/candy-editions/route.ts` DAS group-walk already refreshes every holder collection-wide (46 wallets, full 25,375 supply), so a per-wallet cron would be redundant work. It is the on-demand path for a user pasting/connecting a wallet, and wiring it needs a Candy UI to exist first (`candy-mlb` is `published: false` in `lib/collections.ts` with zero route dirs).

Related: the ghost-owner class it would have papered over is now fixed at the source — `purge_candy_wmc_ghost_rows()` runs daily at 09:10 UTC, 30 min after the 08:40 UTC ingest.

---

## Guardrails (repeat every handoff)

- **Direct to `main`. No branches, no PRs.** If a `claude/*` branch is pre-checked-out, `git checkout main` first.
- **Commit via PowerShell `git` on Windows** — Git Bash `git commit` can silently no-op. Re-verify with `git rev-list --count origin/main..HEAD` (expect `0`).
- **Commit the ledger BEFORE the code** so the code commit is the tip and auto-deploys. A docs-only tip suppresses the Vercel deploy (this trap has bitten three times: 07-16, 07-18, and again this week).
- `curl` fails silently in Git Bash for Vercel REST — use PowerShell `Invoke-WebRequest`.
- Vercel Pro `maxDuration` hard cap is **800s**; higher sends the deploy to ERROR with no visible error text.
- **CRLF:** don't string-replace-patch on Windows. Full-file writes, or `findIndex` on split lines.
- **Before gating or short-circuiting any route, enumerate EVERY caller** — cron-job.org, GHA workflows, `vercel.json`, pg_cron, in-repo fetches. The 07-18 seed-wallet 12h gate silently no-op'd the GHA backstop because the caller sweep stopped at cron-job.org.
- Verify pages by **rendered DOM, not HTTP 200** — streaming shells always return 200.
- **Note:** the "`npm ci` fails on missing `@noble/hashes@2.2.0`" line in an earlier ledger entry is a **sandbox artifact, not a repo defect** — GitHub check-runs show the TypeScript and Cadence-lint jobs (both of which run `npm ci`) passing on `main`. Do not "refresh the lockfile" on that basis.

**Claude Code's direct file inspection wins over this doc and over `project_knowledge_search` on any disagreement — adapt to the actual file shape.**

Skim `docs/overnight/ledger.md` before starting so this doesn't collide with the nightly autonomous pass (it won't touch files committed in the last 24-48h). No `docs/FREEZE.md` needed for this work.

---

## Expected end state

Item 1: a commit on `main` (runner-only) plus a ledger entry recording whether a non-marketplace enumeration exists; if it does, `panini_coverage_audit` shows `listing_gated` families falling from the 12-family / 102-edition baseline. Item 2: a new `candy-offers` pipeline logging `ok=true`, giving Candy its first real price signal — labelled "best offer", never FMV.
