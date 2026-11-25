<!-- Extracted from CLAUDE.md on 2026-08-17 to bring that file under the memory-file
char limit. Content is VERBATIM; CLAUDE.md carries a one-line pointer to this file.
Same rules apply: every number here is a dated sample - re-measure before quoting. -->

## Deferred hardening

Tracked but intentionally unfixed — revisit when adding a real consumer or a per-row write API.

- `email_subscribers`, `outbound_clicks`, `portfolio_snapshots`, `support_conversations` each have an INSERT policy with `qual=true`/`with_check=true` for `roles=public`. Hardening to add when revisited: per-row size caps via CHECK constraints, `created_at`-based rate-limit column or trigger, `bot_score` column populated from BotID, possibly an unauthenticated rate-limiter at the edge.
- **`sales-serial-backfill` accepts its ingest token in a URL QUERY STRING, and its header check is a substring match.** Found 2026-09-02 while redeploying the drifted edge fleet; deliberately NOT bundled into that parity-restoration deploy, because mixing a behaviour change into a "make deployed match repo" deploy destroys the ability to attribute a regression. Two separate defects, and the **second one is the real one**:
  1. `if (!auth.includes(INGEST_TOKEN!) && tokenParam !== INGEST_TOKEN)` — `.includes()` is a substring test, so any `Authorization` value merely *containing* the token passes. **Severity is low and it is effectively dead code**: the only production caller (`app/api/cron/sales-serial-backfill/route.ts`) sends `?token=`, never a header, so the strict-equality branch is the one actually exercised. Every sibling function already uses `auth === \`Bearer ${TOKEN}\``.
  2. ⚠ **The token travels in the URL.** `app/api/cron/sales-serial-backfill/route.ts:41` builds `…/sales-serial-backfill?token=${encodeURIComponent(ingest)}`. Supabase edge-function **logs record full request URLs** (the same property that makes `?key=` logging a documented leak vector — see `rpc-edge-fn-deploy` §6), so `INGEST_SECRET_TOKEN` is written to the log store on every call, ~12×/day. ⛔ **Do not go read the logs to "confirm" this** — reading them IS the leak. The caller's source is sufficient proof.
  ✅ **STEP (b) SHIPPED 2026-09-02** — `app/api/cron/sales-serial-backfill/route.ts` now sends `Authorization: Bearer ${ingest}` and the URL is the bare function path, so **the token stops being written to the edge log store on every call**. ⭐ **It was safe to do BEFORE (a), and the ordering note says why without saying so: the hazard is one-directional — (c) before (b) 401s the caller. (b) alone works against the CURRENTLY DEPLOYED function precisely because its header branch is the sloppy substring test, which `Bearer <token>` satisfies.** Pinned by `__tests__/api-cron-sales-serial-backfill.test.ts` as an **ABSENCE** (the token and `token=` never appear in the outbound URL) rather than as the presence of a header — asserting only the header would pass with the query param still there, which is the exact regression. Mutation-checked. ⛔ **(a) and (c) are NOT done** — both are edge deploys, and this session did not touch the edge fleet or any secret. ⚠ **The token is still to be treated as EXPOSED and rotated: this stops NEW writes, it does not un-write the old ones.**
  ✅ **STEPS (a)+(c) SHIPPED 2026-09-03 (edge fn v38, via MCP; repo file byte-identical):** strict `auth === \`Bearer ${INGEST_TOKEN}\``, header only; the `?token=` branch and the substring test are gone. Deliberately bundled with the same deploy's Top Shot on-chain lane rewrite (ledger 2026-09-03) — the two are attributable in opposite directions (a 401 shows in the Vercel route's log and as no `sales-serial-backfill` row; a lane defect shows in `extra.failures_by_reason`). Boot-probed unauthenticated: the function's own `{"error":"Unauthorized"}` 401. **Only the rotation of `INGEST_SECRET_TOKEN` remains (Trevor — ~15 functions).**
  **Fix order, no window (3 steps, do not reorder):** (a) tighten the header branch to strict `Bearer` equality while KEEPING the `?token=` branch, and deploy — no caller is affected because none uses the header; (b) change the Next.js route to send `Authorization: Bearer ${ingest}` instead of the query param, and let Vercel deploy it; (c) only once (b) is live, delete the `?token=` branch and deploy. Doing (c) before (b) 401s the only caller. **`INGEST_SECRET_TOKEN` should be treated as exposed and rotated after (c)** — it is a shared secret across ~15 edge functions, so that rotation is its own project, not a step here.

- **`buildTopshotPoolPayload` writes `drop_weight 0` for an entire distribution when every parsed edition has `count 0`** (`supabase/functions/_shared/pack-supply-parse.ts` + the hand-copy in `supabase/functions/backfill-topshot-pack-supply/index.ts`). The `|| 1` there prevents a `NaN` write and substitutes a fabricated denominator instead, so the rows say "never drops" where the honest answer is to emit no rows at all. ⚠ **`orig_drop_weight` preserves the raw 0, so the fabrication is recoverable from the sibling column** — which is why this is deferred rather than urgent. **Measured 2026-09-07: 0 of the `gql_historical` distributions in `pack_drop_pool` are degenerate (`sum(orig_drop_weight) = 0`), so it is LATENT, not live.** 🚨 **CORRECTED SAME DAY — THE REASON THIS IS DEFERRED IS THAT IT HAS NO LIVE CALLER, and the first reason recorded here ("it would need its own edge deploy, and bundling that into a display fix destroys attribution") was the weaker one.** That reason dissolves the moment the deploy is its own commit, so it would have licensed a deploy on the next read. **Named the caller instead, per CLAUDE.md, and the answer is nobody:** the only path reaching this code is `backfill-topshot-pack-supply`'s **`mode=pool`** branch (`index.ts:232`), whose sole caller is pg_cron **jobid 16 `rpc-backfill-pack-pool` — `active = false`**; and the one lane that IS active, **jobid 15 `mode=supply`**, has returned **HTTP 530 on every daily run since at least 09-05** because its upstream is the dead `public-api.nbatopshot.com` host already registered as **#50/#65**. Nothing fabricated was ever written (0 degenerate `gql_historical` distributions), and ⚠ **the deployed build's parity with these files is UNVERIFIABLE** — the edge-fn content census has never once produced a result (**#31**), so a deploy would push an unknown delta live on the very function whose half-done deploy caused a **~40 h silent outage** on 2026-08-12. **Deploying to fix dormant code buys nothing and risks that.** Both copies carry a `fabricated-divisor: intentional` marker with this reasoning; `__tests__/no-fabricated-divisor-ratchet.test.ts` walks `supabase/functions`, so a THIRD instance fails CI. **EXIT: when the pool lane is revived (#65), emit no rows at `totalCount === 0` in both copies as part of THAT change and delete both markers — not before, and not as a standalone deploy.**

- **`solUsdOn` (lib/chains/solana/das.ts) prices a PAST Candy sale at TODAY's spot when CoinGecko's history call fails, and negative-caches that day — invisibly** (found 2026-11-02 ~6:00 PM PT, Claude Code cloud, in a memo-cache sweep). It returns a bare number, so neither indexer can record which basis it got, and the das.ts header's "basis is recorded honestly in the sale's `source`" is not true (`source` names the resolver/feed). **Not fixed, by measurement:** of 1,878 Candy sales ingested in 60 days, 0 were priced >1 day after the sale (spot ≈ the day's close), and none has landed since 10-11 (the Candy freeze, #58). **Fix BEFORE any deep-history Candy backfill:** return `{ rate, basis: 'historical'|'spot' }` and skip (park) a days-old sale rather than price it at spot. ✅ **FIXED 2026-11-03 ~10:40 AM PT (Claude Code local):** `solUsdOnWithBasis()` returns `{ rate, basis: "historical"|"spot" }`; spot stands in only for a sale under 24 h old; an older sale with no historical close returns null → both indexers park it as `no_sol_rate` and retry; the failed-day negative cache now expires after 15 min (was process-lifetime). The das.ts header's false "basis recorded in `source`" line corrected. The defect-pinning test was inverted (planted spot fallback reds 3 cases).
- **Parse-failure-as-empty, 2026-11-02 sweep (107 `.catch(() => null|[])` sites), the two non-user-facing remainders:** (1) `lib/allow-list/prewarm.ts:~129` turns a body-parse failure into `{status:"complete", found:0}` and persists it in `prewarm_summary._meta` — the very conflation its comment says it prevents (admin-only); (2) `lib/editions-hydrate.ts:~700` `break`s on a page parse/GraphQL error and memoizes the PARTIAL All Day map in `alldayCachePromise` for the process lifetime — callers route unresolved editions to their `stillMissing` fallback, so nothing false is written, but resolution is lost until a cold start. Fix when next touched: carry `complete:false` / do not memoize a partial walk. ✅ **(2) fixed 11-02 ~5:51 PM PT** — only a walk reaching `hasNextPage=false` is memoized (a thrown walk was ALSO cached as a rejection); page cap 50 → 150 (catalog 6,190). (1) left by decision (admin-only; see ledger).
- **Merge upserts fed by a degraded read — sweep 2026-11-02 (Claude Code cloud), the DORMANT remainder.** Fixed the same day: `/api/wallet-search` cache write (degraded rows insert-only; failed FMV read omits `fmv_usd`), `/api/wallet/seed` (delegates to the walker), edge `backfill-player-names` (stub insert-only). **Left, because nothing reaches them today:** (a) `app/api/ingest/route.ts` `upsertEdition` writes `player_id`/`set_id` from helpers that return NULL on error, and `upsertSet` writes `name: flowName ?? "Unknown Set"` with merge — its upstream has answered 530 since ~08-28 and the GHA step was retired 09-07 (#67 (3)); fix both BEFORE re-adding that step. ✅ **(a) FIXED 2026-11-03 ~10:55 AM PT** — both upserts go through `lib/db/omit-unread.ts`: an unread player_id / set_id / on-chain id / game_date / series / circulation is omitted (the stored value survives), and no "Unknown Set" is invented (`sets.name` is NOT NULL, so a nameless NEW set fails its insert and the edition is written without a set_id). Tests in `api-ingest-deep.test.ts`; planted old shape reds 2. The step stays retired; this only removes the re-add precondition. (b) edge `seed-ufc-editions` merges NULL `player_name`/`thumbnail_url` from partial Flowty payloads — Flowty is retired (10-30). (c) edge `scan-ufc-wallet` ignores the editions-read error (`edition_id` NULL on every row) — UFC market closed. (d) `offers-sweep` writes `set_uuid`/`play_uuid ?? null` over stored UUIDs (low). ✅ **(d) FIXED 2026-11-03 ~10:45 AM PT** — `lib/offers/edition-offer-rows.ts` omits an unread UUID and upserts rows grouped by key shape, so no batch's column union carries a NULL UUID (`__tests__/offers-edition-offer-rows-omit-unread-uuids.test.ts`; planted null reds 2). ⚠ The lane itself is RETIRED (cron-job.org 7712610 inactive since 09-07; its GraphQL host answers 530 — dead-lane-backstop.yml) — so this closes the hazard for a re-enable, it changed no live write. **Rule:** a value you could not READ is omitted from a merge write or written insert-only — never sent as NULL.
- `user_achievements` + `watchlist_items` migrated 2026-04-27 to service-role-only writes. Both still use `owner_key` (text) instead of user_id UUID. Neither table is referenced by any /api route today. When a real consumer arrives, do the user_id+RLS migration like saved_wallets / trophy_moments / profile_bio.
- `badge_editions.low_ask` coverage gap — **AllDay RESOLVED (verified 2026-07-17), the cron this note asked for is LIVE.** `allday-badge-low-ask-refresh` (pipeline_runs, `nfl_all_day`, every 30 min, ok=true, ~3,800 rows/refresh) now keeps AllDay at **3,897/5,607 (69.5%), fresh same-day** — the old "0/1572 always NULL" is stale; do NOT build a second AllDay cron. TopShot healthy and fresh (1,929 low_ask + 1,929 offers; the pct fell to ~28% only because the badge-set backfill grew the row count 2,987→6,930, not a regression). **Golazos low_ask RESOLVED (verified live 2026-07-27, supersedes the "111/218, no pipeline, UNIDENTIFIED" note this bullet used to carry).** The `golazos-badge-low-ask-refresh` cron IS live and healthy (pg_cron `10,40 * * * *`, last run `succeeded`; SECDEF `refresh_golazos_badge_low_ask()` self-heals `edition_id` via `resolve_golazos_listing_edition_ids()` then reads `golazos_edition_floor_ask`), holding Golazos at **81/218 low_ask, fresh same-hour**. The 37% ceiling is **listing-gated** (only editions with a live Flowty floor get a `low_ask`), not a bug — do NOT build a second Golazos low_ask cron. **The one genuinely-open Golazos gap is `highest_offer` 0/218:** unlike `low_ask` (which the refresh fills), `highest_offer` is fed by the offers pipeline (`edition_offers`), and `edition_offers` holds **ZERO Golazos rows** — there is no Golazos offer source at all. Filling it therefore requires a NEW Golazos offers indexer (a DapperOffersV2 sweep), a real ingest project, not a refresh tweak — operator/ingest call, not autonomous. **STAGED 2026-07-28 (inert, pending one on-chain recon):** `app/api/golazos-offers-indexer/route.ts` (mirror of the live `allday-offers-indexer`) + `golazos_open_offers` table are committed but **uncronned** — the gate is whether Golazos OffersV2 offers are EDITION-type (unverifiable from the cloud sandbox: no Flow REST egress). One authenticated POST from prod settles it; see [docs/handoff-2026-07-28-golazos-offers-indexer.md](../../docs/handoff-2026-07-28-golazos-offers-indexer.md).
  ✅ **THAT POST WAS RUN ON 2026-07-28 AND THE GATE IS SETTLED — the answer just never made it back to this bullet.** It is recorded in the route's own header (`app/api/golazos-offers-indexer/route.ts`) and nowhere else, which is why this line still reads as open. **The result is NOT the "NFT-type offers" case this bullet hypothesizes: Golazos has NO DapperOffersV2 offers at all, of EITHER type.** The gated POST returned `ok:true / pages 60 / offersSeen 0`, and an independent Flow REST sweep found **zero Golazos `OfferAvailable` events in a contiguous 400,000-block window** (~4 days, 14,495 offers total — TopShot 9,460, MFLPlayer 3,986, AllDay 775, MFLClub 274, **Golazos 0**, UFC 0), plus zero across six spot samples spanning 2026-02 → 2026-07. Positive control on the same contract and code path in the same 24 h: allday-offers-indexer 142 offers, topshot-offers-indexer 1,979. **The cause is demand, not plumbing.** ⚠ **Re-derived live 2026-08-23** (numbers move, the conclusion does not): `golazos_open_offers` **0 rows**, `badge_editions` Golazos `highest_offer` **0/218**, `low_ask` **75/218** (this bullet says 81 — a dated sample), and 30-day sales **Golazos 70 vs Top Shot 110,873**, a 1:1,584 ratio — *more* extreme than the 123-vs-90,612 at recon time. **So building the offers indexer would index nothing. Do not schedule it, and do not re-run the recon** — re-test only by POSTing the existing inert route and reading `offersSeen`.

---

## Known issues / active work

Main branch is the canonical clean branch.

**Status reconciled 2026-05-23** against the codebase + production DB. Full verification table: `docs/health/PROJECT_HEALTH_2026-05-22.md` §9. Item numbers below are stable (they match the report); resolved items are listed at the end under their original numbers.

### Platform changes (May 2026) — these make several sections of this file stale

- ✅ **EXECUTED 2026-10-30 — the Flowty API went dark 10-27 ~9:20 PM PT and the three listing-cache lanes, `/api/listing-cache`, `golazos-sniper-feed`, their schedulers, the Flowty rows and `flowty-proxy` (now a 410 tombstone) are retired; record: [flowty-retirement-runbook.md](../operations/flowty-retirement-runbook.md) § Execution record.** **Flowty shut down its NFT marketplace FRONTEND (~2026-05-13) — but its API is ALIVE (re-verified 2026-07-07: api2.flowty.io serves current Series-8 listings; the infra now backs dapper.market).** The loan-book (`flowty_loans` / `flowty_loan_events`) ingest and analytics MVs are frozen history, but the `flowty-proxy` edge fn + listing-cache routes are LIVE ingest feeding cached_listings/ASK-FMV today — do not treat them as dead. The "Flowty API", sniper-feed, and worker sections of this file describe what is now legacy/dead infrastructure pending a deliberate teardown. `flowty_loan_events` going cold on 2026-05-11 is expected behaviour, not a regression.
- **NFL All Day ended primary pack sales.** AllDay `PackNFT.Mint` ingestion and AllDay pack-EV are historical-only; AllDay is a secondary-market collection going forward.

### Open

> ⭐ **REGISTER RE-READ 2026-10-17 ~6:00–6:05 PM PT (Claude Code cloud, documentation-refresh pass) — the 1 open + 5 partial items, plus the items roadmap-status.md's open-items list cites, each re-derived live (read-only).** **Still open:** **#22** (leaked commit still public; the 10-08 re-test task ran silently — note added to the item). **Still partial, wording current:** **#17** (only the deferred low-severity tail; a candidate to close by decision), **#66** (Search Console re-read 10-28), **#114** (15 live Cowork dashboards; unreachable from a cloud sandbox, last measured 09-14), **#181** (count 410 → 590; decision due 10-24 — note added), **#189** (3,238 of 21,372 still unsourced, matches the item). **Closed items re-confirmed:** **#55** (both Routine ids return not-found), **#8** (still 0/16; suppression date corrected to PT — note added), **#58** (shelved; its revisit trigger is live — 0 indexed Candy sales since 10-11 8:21 PM PT).
> ⚠ **Everything this stamp does not name was NOT swept.**

> ⭐ **REGISTER RE-READ 2026-09-08 EVENING (PT) — documentation-refresh pass, and it found the fastest rot yet recorded here: a claim that went stale in FOUR HOURS.**
> **Corrected:** **#67** — its item (2) told the reader the ~74,297 historical Atlas sales were "paced on jobid 481" and to "retire 481 when `extra.remaining` reads 0". **jobid 481 was unscheduled the same night after causing an IO spell**, so the historical half is not draining and the number it names can never reach 0. ⭐ **The entry was written by the session that shipped the job, hours before the session that pulled it — both correct when written, and the register only carried the first half.** Re-derived live: no `cron.job` row matches, 6,589 `atlas_backfill` rows, `remaining` frozen at 74,297.
> **Re-verified STILL OPEN, which is the half a sweep usually omits:** **#8** (`sync-nba-projections` **16 runs / 0 ok / 0 rows** in 48 h to 2026-09-09 03:0xZ — unchanged, still a permanently-red arm) and **#55** (both 2-hourly Routines read `enabled: false` in the Routine list, last successful fire **2026-09-01**; the item's "they are DISABLED and need one click on one machine" is exactly right, eight days on).
> **New:** **#69** — ⚠ *its headline was RETRACTED the next day: the beacon's "first real finding" was a headless crawler, not a user-facing defect; what was real is the alert-arm defect it exposed, since fixed and re-verified* — and **#70**, All Day's M2 slide, which had slid seven points across four readings with no register row at all. ⭐ **That gap was the finding**: this file's own rule is that an item which matters and is still open should have a row, and M2's absence is why nobody was watching it while M1 was watched closely.
> ⚠ **Everything this stamp does not name was NOT swept.** It was a documentation pass, not an audit: it re-derived what the docs CLAIMED, not everything the register holds.

> ⭐ **REGISTER STALENESS SWEEP 2026-09-08 (PT) — four items settled by a LIVE read, and every one of them OVERSTATED a problem that had already been fixed.** This pass deliberately looked for items that had *rotted in the reassuring direction* — an entry that still reads OPEN long after its cause was removed, which is the shape nobody re-checks because an open item looks like diligence.
> **Closed on evidence:** **#38** (`topshot-pack-pool-backfill` — ZERO runs in the whole retention window, `max(started_at)` NULL, pg_cron jobid 16 `active = false` since 2026-08-29; the 99.6 %-failure picture describes a pipeline that no longer runs) · **#31** (Tier 2 has run since 08-30 per **#53**; today's log reads `content census: 38 body/bodies read, 0 failed`) · **#23** (drift is **6**, not 25, and all six are deliberate — 2 deferred-by-decision, 4 do-not-redeploy).
> **Updated but deliberately NOT closed:** **#21** — the hydrator worker logs nothing and #65's pg_cron pair does the work, so the ACTION changes from *codify its cron* to *retire it*, but Cloudflare is unreadable from a session and retired-vs-silently-failing cannot be told apart from here.
> ⛔ **CHECKED AND LEFT OPEN, which is the half of a sweep that usually goes unrecorded: #11.** Its named sub-item really is a ghost, but it carries a REAL remainder (the ungated Phase-2 brand-token debt), so it is not stale. **An old item is not a stale item — the sweep has to be able to return "still open".**
> 
> ⭐⭐ **STANDING RULE THIS SWEEP EARNED — AN OPEN ITEM ROTS IN THE REASSURING DIRECTION.** A stale CLOSED entry gets caught the moment someone needs the thing. A stale OPEN entry just sits there being wrong, because **an open item looks like diligence** — so nobody re-checks it, and every reader who skims it inherits the wrong priority. Four of the five items examined on 2026-09-08 were overstating a problem already fixed, three of them by OTHER sessions whose work never came back here. ⚠ **Before acting on OR citing an item, re-derive its load-bearing claim from the live system** — for anything naming a pipeline, job or workflow that is one query. ⛔ **And a sweep must be able to return "still open" (#11 did), or it is a closing spree.** When you do close one, preserve the original diagnosis: these are usually correct-when-written, not wrong.
> ⚠ **Everything this stamp does not name was NOT swept this pass.** In particular the operator-gated items (#22, #32, #55, #58), the Trevor-decision items (#33, #39, #54, #64) and the measurement items (#29, #42, #43, #48) carry their own older dates — read those, not this one.
> ⭐ **REGISTER RE-READ 2026-08-27 (PT), interactive memory-refresh pass. Every item it touched was settled by a LIVE read, never a re-quote:** **#8** (still 0 ok — and on a bigger window than the 08-26 stamp: **0 ok / 16 failed in 48 h**, newest 2026-08-28 03:07Z, `all_upstreams_failed`), **#22** (unchanged, and confirmed by a THIRD instrument), **#27** (job population re-derived: 100 jobs / 45 `cron_heavy`), **#34** (Sentry blackout unbroken, 9 days), **#38** (first post-fix reading), plus **NEW #47** (`candy-editions-ingest` kills).
> ⚠ **Everything this stamp does not name was NOT swept this pass** — including every item the 08-26 stamp names. **An item carries the date of the newest stamp that names it, and no other.**

> ⭐ **REGISTER SWEEP 2026-08-26 (PT) — every item below whose status could be settled by a live read WAS re-read, not re-quoted.** Touched this pass: **#8** (still regressed, 0/8 ok), **#27** (unchanged, and 15 of 99 active jobs share the 600 s default), **#29** (ratio moved; the two failures are upstream 503s, not kills), **#30** (index shipped, hypothesis MEASURED, residual is now egress), **#34** (Trevor decided: no Sentry spend — mitigations shipped instead), **#35** (cadence cut REVERTED and the revert confirmed), **#36** (shipped, correctness proven, cost claim NOT), plus two new items **#37** (React #418 live in production) and **#38** (a 99.6%-failed pipeline that was filed but never registered).
> ⚠ **Not swept, and named rather than left implied:** #10, #11, #14, #17, #18, #20, #21, #22 (re-verified separately — still live), #23, #25, #31, #32, #33. **An item this stamp does not name carries its own older date; read that date, not this one.**

<!-- BEGIN:ITEM-INDEX (generated by scripts/gen-known-issues-index.mjs — do not hand-edit) -->

**STATUS INDEX — 259 numbered items in this section: 3 open · 1 partial · 255 closed.**

⚠ **Items are NEVER renumbered or re-sorted** — the ledger, `focus.md`, inbox filings, CLAUDE.md and
migration record files all cite them by number, so a closed item keeps its slot rather than moving to
`### Resolved`. **This index is how you skip the closed ones**, not a reason to move them.

⚠ **Status is DERIVED from each item's own first sentence**, not from a curated list — so it cannot
silently disagree with the item, and an index row that reads wrong means the ITEM's opening words are
wrong. Fix the item, then re-run `npm run docs:issues-index`.
⛔ **`closed` here means the item SAYS it is closed. It is not a re-verification** — read the item's own
date stamp, and this file's standing rule that every recorded status has a shelf life.

| item | status | what it is |
|---|---|---|
| **#0** | ✅ closed | Wallet verification — RESOLVED BY REMOVAL 2026-08-08 (Trevor directive): RPC offers NO wallet s… |
| **#1** | ✅ closed | Cart execution — SHELVED 2026-05-24, FRONTEND + API DELETED 2026-08-01 (see the Update at the e… |
| **#3** | ✅ closed | Trade Hub — SHELVED 2026-06-01, DELETED FROM THE TREE 2026-08-01 (see the final Update in this… |
| **#3b** | ✅ closed | Gifting — REMOVED from the frontend 2026-08-01 (READ-ONLY directive, Trevor). |
| **#4** | ✅ closed | Pinnacle FMV — RESOLVED (verified 2026-05-24; table renamed 2026-06-08, re-verified 2026-06-28). |
| **#7** | ✅ closed | AllDay unmapped_sales backlog  |
| **#9** | ✅ closed | Storefront audit pipeline  |
| **#8** | ✅ closed | RESOLVED 2026-10-24 ~8:50 AM PT (Cowork cloud; Trevor |
| **#10** | ✅ closed | RESOLVED 2026-09-24 — re-derived: the token migration is effectively DONE, and the 09-23 re-aud… |
| **#11** | ✅ closed | RESOLVED 2026-10-10 ~8:54 AM PT (Claude Code cloud, known-issues triage pass under Trevor's "ma… |
| **#12** | ✅ closed | Blazers trivia — CLOSED 2026-08-17: the file this slot cites does not exist. |
| **#14** | ✅ closed | SHELVED 2026-09-24 (decided under Trevor's delegation)  |
| **#15** | ✅ closed | livetoken-portfolio.json fixtures  |
| **#17** | ✅ closed | CLOSED 2026-10-17 by decision (Claude Code cloud; Trevor |
| **#18** | ✅ closed | RESOLVED 2026-10-10 ~11:53 AM PT  |
| **#19** | ✅ closed | RESOLVED 2026-08-22 — jobid 70 moved to 23:35Z via a migration; no grant was made or needed. |
| **#26** | ✅ closed | RESOLVED 2026-09-24 — no flap on Large. |
| **#26b** | ✅ closed | (historical — the original filing, superseded by 26 above; kept because its evidence is what id… |
| **#20** | ✅ closed | RESOLVED NEGATIVELY 2026-08-31, atlas-proxy deployed and Cloudflare egress is Atlas-WAF-blocked |
| **#21** | ✅ closed | RESOLVED IN REPO 2026-09-23  |
| **#22** | ✅ closed | RESOLVED 2026-10-26 ~8:45 PM PT  |
| **#23** | ✅ closed | CLOSED 2026-09-08 — RE-READ FROM THE DETECTOR'S OWN LOG, and the number is 6, not 25, with ever… |
| **#24** | ✅ closed | RESOLVED 2026-08-22 — all 6 closed. |
| **#25** | ✅ closed | RESOLVED 2026-09-25 ~9:40 PM PT  |
| **#27** | ✅ closed | RESOLVED 2026-09-02 — jobs 352/353/354 re-registered at 300s via cron.alter_job from the Cowork… |
| **#28** | ✅ closed | RESOLVED — code fix 2026-08-23 (9b862dc8), and VERIFIED IN PRODUCTION AGAINST THE DATABASE 2026… |
| **#29** | ✅ closed | CLOSED 2026-09-23 — premise gone: jobid 55 was unscheduled 09-04, so the lane has no caller; wh… |
| **#30** | ✅ closed | CLOSED — ACCEPTED 2026-09-24 (decided under Trevor's delegation): this item's 6-a-day threshold… |
| **#33** | ✅ closed | RESOLVED 2026-10-10 ~3:45 PM PT (Claude Code cloud, decided under Trevor's "use your best judge… |
| **#32** | ✅ closed | CLOSED 2026-09-20 — Trevor saved the merged rpc-cron-ops card at 9:48 PM PT 09-19; verified fro… |
| **#31** | ✅ closed | CLOSED 2026-09-08 — SUPERSEDED BY #53, and confirmed by a live read rather than by trusting tha… |
| **#34** | ✅ closed | RESOLVED 2026-10-10 ~8:54 AM PT (Claude Code cloud, known-issues triage pass under Trevor's "ma… |
| **#35** | ✅ closed | CLOSED 2026-09-24 ~8:50 AM PT  |
| **#36** | ✅ closed | RESOLVED 2026-09-07 — the 08-30 body's cost read as a 3.4-day flow is 33 % / 91 % of the T1 thr… |
| **#37** | ✅ closed | RESOLVED 2026-08-27 — VERIFIED DETERMINISTICALLY, not by a lucky green run. Filed 2026-08-26 —… |
| **#38** | ✅ closed | CLOSED 2026-09-08 BY THE PAUSE  |
| **#39** | ✅ closed | RESOLVED 2026-09-24 — the Large compute tier (09-20) plus the warmer closed it. |
| **#40** | ✅ closed | CLOSED 2026-09-02 — the one observation this item was waiting on is in, over a WEEK not a tick:… |
| **#41** | ✅ closed | CLOSED 2026-09-01 by re-derivation  |
| **#42** | ✅ closed | CLOSED 2026-09-23 — premise gone: 0 failed pg_cron runs of 27,262 since 09-21 00:00 PT (busy 2.… |
| **#43** | ✅ closed | CLOSED — POLICY DECIDED 2026-09-24 (under Trevor's delegation). |
| **#44** | ✅ closed | CLOSED 2026-08-27 (Trevor’s call)  |
| **#45** | ✅ closed | RESOLVED 2026-08-28 (register was stale  |
| **#46** | ✅ closed | RESOLVED 2026-08-29 — the root cause was DEFECT 3 (the template-interpolation desync), it is fi… |
| **#47** | ✅ closed | CLOSED 2026-09-01 — THE EXPERIMENT'S FALSIFIER IS ANSWERED AND NOT MET: the kills stopped. ⚠ Bu… |
| **#48** | ✅ closed | CLOSED 2026-09-23 — wallet backfill completes every dispatch (1,042 of 1,042 over 73 h) and the… |
| **#49** | ✅ closed | CLOSED — ACCEPTED 2026-09-24 on a fresh measurement. |
| **#50** | ✅ closed | CLOSED — EXTENDED 2026-09-24 8:06 / 8:09 PM PT to All Day and Golazos (20260925030613, 20260925… |
| **#51** | ✅ closed | RESOLVED 2026-10-10 ~8:54 AM PT (Claude Code cloud, known-issues triage pass under Trevor's "ma… |
| **#52** | ✅ closed | RESOLVED 2026-10-10 ~8:54 AM PT (Claude Code cloud, known-issues triage pass under Trevor's "ma… |
| **#53** | ✅ closed | RESOLVED 2026-08-30 — TIER 2 RUNS: the eszip parse-mode census read 38/38 deployed bundles, and… |
| **#54** | ✅ closed | CLOSED 2026-09-23 — the input gate is live (runs of 26–283 ms, gated, ok), so the waste is gone… |
| **#55** | ✅ closed | RESOLVED 2026-09-23 — both disabled Routines DELETED |
| **#56** | ✅ closed | RESOLVED 2026-09-27 ~11:00 PM PT  |
| **#57** | ✅ closed | RESOLVED 2026-09-02 (same day it was opened)  |
| **#58** | ✅ closed | RESOLVED BY MEASUREMENT 2026-10-25 ~7:20 PM PT (Cowork cloud, read-only)  |
| **#59** | ✅ closed | RESOLVED 2026-09-06 (same day)  |
| **#60** | ✅ closed | CLOSED — RISK ACCEPTED 2026-09-23. |
| **#61** | ✅ closed | RESOLVED 2026-10-10 ~8:54 AM PT (Claude Code cloud, known-issues triage pass under Trevor's "ma… |
| **#62** | ✅ closed | CLOSED 2026-09-23 — a reference note, not a defect: mobile-sweep.mjs and mobile-layout.spec.ts… |
| **#63** | ✅ closed | CLOSED 2026-09-23 — Candy has Overview, Market, Collection and Analytics tabs plus entity pages… |
| **#64** | ✅ closed | RESOLVED 2026-09-25 ~10:30 PM PT  |
| **#65** | ✅ closed | RESOLVED 2026-10-10 ~9:50 AM PT  |
| **#66** | 🟠 partial | PARTLY DONE — RE-GATED 2026-11-23 ~11:40 AM PT (Claude Code cloud; Trevor: "try to resolve thes… |
| **#67** | ✅ closed | CLOSED — DECIDED 2026-09-24 (under Trevor's delegation): no full-budget historical walk. |
| **#68** | ✅ closed | CLOSED 2026-09-08 — rows drained (33,000, backed up), the per-partition constraint shipped and… |
| **#69** | ✅ closed | RESOLVED 2026-09-11, RETRACTED AS A DEFECT  |
| **#70** | ✅ closed | RESOLVED 2026-10-10 ~10:05 PM PT (Claude Code cloud, code 0a763bf0e)  |
| **#71** | ✅ closed | CLOSED — ACCEPTED 2026-09-24. |
| **#72** | ✅ closed | RESOLVED 2026-10-10 ~8:54 AM PT (Claude Code cloud, known-issues triage pass under Trevor's "ma… |
| **#73** | ✅ closed | RESOLVED 2026-10-10 ~8:54 AM PT (Claude Code cloud, known-issues triage pass under Trevor's "ma… |
| **#74** | ✅ closed | RESOLVED 2026-10-10 ~9:21 AM PT (Claude Code cloud); the MISSED HALF closed 2026-10-14 ~7:35 PM… |
| **#75** | ✅ closed | CLOSED 2026-09-20 (PT) — ITS SUBJECT IS GONE AND ITS ARMED RE-CHECK IS ANSWERED, THOUGH NOT BY… |
| **#76** | ✅ closed | RESOLVED 2026-10-13 ~6:40 AM PT  |
| **#77** | ✅ closed | CLOSED 2026-09-23 — email and Telegram both deliver on 88 of 88 sentinel runs since 09-20 9:04… |
| **#78** | ✅ closed | CLOSED 2026-09-12 (PT) — THE LANE IS HEALTHY, ESTABLISHED WITH A POSITIVE CONTROL RATHER THAN B… |
| **#79** | ✅ closed | RESOLVED 2026-10-10 ~11:12 AM PT (decided under Trevor's delegation)  |
| **#80** | ✅ closed | RESOLVED 2026-10-10 ~8:54 AM PT (Claude Code cloud, known-issues triage pass under Trevor's "ma… |
| **#81** | ✅ closed | RETIRED 2026-09-23 (decided)  |
| **#82** | ✅ closed | CLOSED 2026-09-23 — impossible_parallel_serials has read 0 every day 09-15→09-23 across 35 of 3… |
| **#83** | ✅ closed | RESOLVED 2026-09-24 — the existing rows are backfilled (decided under Trevor's delegation). |
| **#84** | ✅ closed | RESOLVED 2026-10-10 ~8:54 AM PT (Claude Code cloud, known-issues triage pass under Trevor's "ma… |
| **#85** | ✅ closed | RESOLVED 2026-10-10 ~11:18 AM PT (decided under Trevor's delegation)  |
| **#86** | ✅ closed | RESOLVED 2026-09-12 (same hour it was found)  |
| **#87** | ✅ closed | RESOLVED 2026-09-12 (same day)  |
| **#88** | ✅ closed | RESOLVED 2026-10-10 ~10:15 AM PT  |
| **#89** | ✅ closed | CLOSED 2026-09-12 (PT) — THE 4 MB CAP CAN NO LONGER STRIP PINNACLE ART, MEASURED IN PRODUCTION… |
| **#90** | ✅ closed | RETIRED 2026-09-24 (decided under Trevor's delegation)  |
| **#91** | ✅ closed | CLOSED — ACCEPTED 2026-09-24 (option c, measured). |
| **#92** | ✅ closed | RESOLVED 2026-09-12 (PT), same night it was filed  |
| **#93** | ✅ closed | RESOLVED 2026-10-10 ~8:54 AM PT (Claude Code cloud, known-issues triage pass under Trevor's "ma… |
| **#94** | ✅ closed | RESOLVED 2026-10-10 ~8:25 AM PT (Cowork cloud)  |
| **#95** | ✅ closed | CLOSED 2026-09-13 (PT) — every half is now answered: the COUNT measured, the PRICE measured at… |
| **#96** | ✅ closed | CLOSED 2026-09-13 (PT) — SHIPPED: THE PROFILE OG CARD NAMES ITS MOMENTS, AT EVERY GRID SIZE. Fi… |
| **#97** | ✅ closed | CLOSED THE DAY IT BIT FOR THE THIRD TIME, 2026-09-12 (PT)  |
| **#98** | ✅ closed | SHELVED 2026-09-24, a follow-on of #81's decision. |
| **#99** | ✅ closed | RESOLVED 2026-09-24 — the floor is back at 2023-11-08 (#109's filtered indexes landed), and the… |
| **#100** | ✅ closed | CLOSED 2026-09-23 — the cron-job.org :04 trigger is live: 29–31 ok sweeps a day since 09-14, ma… |
| **#101** | ✅ closed | RESOLVED 2026-10-10 ~11:31 AM PT (datapoint 2026-10-14 ~6:52 PM PT)  |
| **#102** | ✅ closed | RESOLVED 2026-10-10 ~11:59 AM PT (decided under Trevor's delegation). |
| **#103** | ✅ closed | CLOSED 2026-09-23 — retry jobid 490 filled 09-18 and 09-19 after primary timeouts; every date 0… |
| **#104** | ✅ closed | CLOSED — ACCEPTED 2026-09-24 (the 09-13 decision re-confirmed on Large). |
| **#105** | ✅ closed | CLOSED 2026-09-13 (PT), the day Cowork filed it  |
| **#106** | ✅ closed | CLOSED 2026-09-13 (PT), same session it was found  |
| **#107** | ✅ closed | CLOSED 2026-09-23 — the retry storm is gone: 449 of 449 fmv-recalc ticks finished (72 h to 09-2… |
| **#108** | ✅ closed | CLOSED — ACCEPTED 2026-09-24. |
| **#109** | ✅ closed | RESOLVED 2026-09-23 — the three claimable filtered indexes are built and the floor is back at 2… |
| **#110** | ✅ closed | CLOSED 2026-09-23 — exit met: runs 09-14→09-23 wrote 3,053 base→parallel and 0 parallel→own-bas… |
| **#111** | ✅ closed | CLOSED 2026-09-13 4:2x PM (PT), the same afternoon  |
| **#112** | ✅ closed | RESOLVED 2026-09-13 (PT)  |
| **#113** | ✅ closed | RESOLVED 2026-10-10 ~8:54 AM PT (Claude Code cloud, known-issues triage pass under Trevor's "ma… |
| **#114** | ✅ closed | RESOLVED 2026-10-20 ~10:05 AM PT (Cowork cloud, laptop linked; Trevor |
| **#115** | ✅ closed | CLOSED 2026-09-19 (PT) — THE PROPERTY IS WATCHED, BY THREE BAN-AT-ZERO ARMS, AND THE LAST ONE S… |
| **#116** | ✅ closed | RESOLVED 2026-10-10 ~8:54 AM PT (Claude Code cloud, known-issues triage pass under Trevor's "ma… |
| **#117** | ✅ closed | CLOSED 2026-09-23 — withdrawn filing, kept as a record; on 09-23 the arm shows 7 degraded and 0… |
| **#118** | ✅ closed | RESOLVED 2026-10-10 ~11:05 AM PT  |
| **#119** | ✅ closed | RESOLVED 2026-09-24 — the write-side guard is now LIVE in the function, not only in the table. |
| **#120** | ✅ closed | RESOLVED 2026-10-10 ~8:54 AM PT (Claude Code cloud, known-issues triage pass under Trevor's "ma… |
| **#121** | ✅ closed | CLOSED 2026-09-20 (PT) — IT NO LONGER REPRODUCES, AND THE MECHANISM WAS THE VISIBILITY MAP, NOT… |
| **#122** | ✅ closed | RESOLVED 2026-09-18 12:0x PM PT (was OPEN, filed ~7:45 AM PT) |
| **#123** | ✅ closed | RESOLVED 2026-09-27 ~11:40 PM PT (thread close)  |
| **#124** | ✅ closed | CLOSED 2026-09-19 (opened 2026-09-18)  |
| **#125** | ✅ closed | CLOSED 2026-09-23 (PT) ON ITS OWN FIRST-TICK FALSIFIER  |
| **#126** | ✅ closed | RESOLVED 2026-09-20 ~11:5x AM PT  |
| **#127** | ✅ closed | CLOSED — ACCEPTED 2026-09-24 after sizing AND tracing the exposed reader; no eviction. |
| **#128** | ✅ closed | RESOLVED 2026-10-10 ~8:54 AM PT (Claude Code cloud, known-issues triage pass under Trevor's "ma… |
| **#129** | ✅ closed | RESOLVED 2026-09-23 (PT)  |
| **#130** | ✅ closed | RESOLVED 2026-09-20 6:20 PM PT (the ledger's 09-20 "GATE-KEY ROTATION FINALLY COMPLETES" entry |
| **#131** | ✅ closed | RESOLVED 2026-09-23 5:35 PM PT  |
| **#132** | ✅ closed | CLOSED — ACCEPTED 2026-09-23: board row links stay as they are. |
| **#133** | ✅ closed | CLOSED 2026-09-23 ~8:40 PM PT  |
| **#134** | ✅ closed | RESOLVED BY DECISION 2026-09-27 ~11:40 PM PT (thread close)  |
| **#135** | ✅ closed | CLOSED 2026-09-24 3:35 PM PT  |
| **#136** | ✅ closed | CLOSED 2026-09-25 ~7:20 AM PT  |
| **#137** | ✅ closed | CLOSED 2026-09-25 ~7:30 AM PT (Trevor decided (a) and (b) 09-25)  |
| **#138** | ✅ closed | CLOSED — DECIDED 2026-09-25 ~7:25 AM PT: no mega-wallet id source is built now; nothing user-fa… |
| **#139** | ✅ closed | RESOLVED — every pair resolved against NBA.com and NFL.com and applied 2026-09-25 ~2:30 PM PT:… |
| **#140** | ✅ closed | RESOLVED 2026-09-25 ~8:15 PM PT  |
| **#141** | ✅ closed | RESOLVED 2026-09-25 ~7:05 PM PT  |
| **#142** | ✅ closed | RESOLVED 2026-09-27 ~11:10 PM PT  |
| **#143** | ✅ closed | RESOLVED 2026-10-10 ~9:05 AM PT (Cowork cloud, decided under Trevor's "make decisions on these… |
| **#144** | ✅ closed | RESOLVED 2026-10-04 8:55 AM PT  |
| **#145** | ✅ closed | RESOLVED 2026-09-27 ~11:20 PM PT  |
| **#146** | ✅ closed | ✅ RESOLVED 2026-09-26 ~9:05 AM PT  |
| **#147** | ✅ closed | CLOSED 2026-10-03 ~8:05 PM PT (Claude Code cloud)  |
| **#148** | ✅ closed | CLOSED 2026-09-26 ~8:50 AM PT  |
| **#149** | ✅ closed | RESOLVED 2026-10-10 ~8:25 AM PT (Cowork cloud)  |
| **#150** | ✅ closed | ✅ RESOLVED 2026-09-26 ~2:55 PM PT  |
| **#151** | ✅ closed | ✅ RESOLVED 2026-09-27 ~9:40 AM PT  |
| **#152** | ✅ closed | ✅ RESOLVED 2026-09-27 ~10:48 AM PT  |
| **#153** | ✅ closed | ✅ RESOLVED 2026-09-27 ~10:20 AM PT  |
| **#154** | ✅ closed | ✅ RESOLVED 2026-09-27 ~11:00 AM PT  |
| **#155** | ✅ closed | RESOLVED 2026-09-27 — Disney Pinnacle render FMV was a WAP-centred trimmed average that dropped… |
| **#156** | ✅ closed | RESOLVED 2026-09-28 — Disney Pinnacle sales of SERIALISED pins were missing their serial number… |
| **#157** | ✅ closed | RESOLVED 2026-09-28 — Disney Pinnacle pack EV was computed per SUB-DISTRIBUTION of a drop, so a… |
| **#158** | ✅ closed | RESOLVED 2026-09-28 — A refresh STARVATION LOOP: a stats-only reconciler stamped seeded_wallets… |
| **#159** | ✅ closed | RESOLVED 2026-09-28 — 25,793 Disney Pinnacle sales were counted TWICE: studio-history rows dupl… |
| **#160** | ✅ closed | RESOLVED 2026-10-11 ~10:50 AM PT (Claude Code) |
| **#161** | ✅ closed | RESOLVED 2026-09-30 ~5:40 PM PT  |
| **#162** | ✅ closed | RESOLVED 2026-09-29 (Trevor |
| **#163** | ✅ closed | RESOLVED 2026-10-03 (PT)  |
| **#164** | ✅ closed | RESOLVED 2026-10-03 (PT)  |
| **#165** | ✅ closed | RESOLVED 2026-09-30 ~7:34 PM PT  |
| **#166** | ✅ closed | ✅ RESOLVED 2026-10-02 ~9:57 PM PT (decided under Trevor's delegation |
| **#167** | ✅ closed | RESOLVED 2026-10-10 ~9:17 AM PT (Claude Code cloud): |
| **#168** | ✅ closed | RESOLVED 2026-10-03 ~11:30 AM PT  |
| **#169** | ✅ closed | RESOLVED 2026-10-10 ~5:59 AM PT (Claude Code cloud) |
| **#170** | ✅ closed | RESOLVED 2026-10-04 ~7:35 AM PT (Cowork cloud, Supabase SQL editor in Trevor's Chrome; MCP appl… |
| **#171** | ✅ closed | RESOLVED 2026-10-10 ~11:35 AM PT (decided under Trevor's delegation)  |
| **#172** | ✅ closed | SHELVED 2026-10-17 by decision (Claude Code, Windows box; Trevor |
| **#173** | ✅ closed | RESOLVED 2026-10-09 ~1:39 PM PT (was OPEN 2026-10-04 ~6:45 PM PT)  |
| **#174** | ✅ closed | DECIDED 2026-10-04 (~8:50 PM PT, Cowork cloud; Trevor |
| **#175** | ✅ closed | RESOLVED 2026-10-10 ~8:56 AM PT (Cowork cloud, decided under Trevor's "make decisions on these… |
| **#176** | ✅ closed | RESOLVED 2026-10-10 ~9:00 AM PT (Claude Code cloud) |
| **#177** | ✅ closed | RESOLVED 2026-10-10 ~7:37 AM PT (Claude Code cloud) |
| **#178** | ✅ closed | RESOLVED 2026-10-10 ~3:25 AM PT (Cowork cloud; decided under Trevor's "fix any issues you encou… |
| **#179** | ✅ closed | RESOLVED (FIXED) 2026-10-10 ~3:15 AM PT (Cowork cloud; Trevor |
| **#180** | ✅ closed | RESOLVED 2026-10-10 ~9:14 AM PT (Claude Code cloud) |
| **#181** | ✅ closed | RESOLVED 2026-11-08 ~9:20 AM PT (Claude Code, Windows box) |
| **#182** | ✅ closed | RESOLVED 2026-10-10 (~5:10 AM PT, Claude Code cloud, f4dd1891d |
| **#183** | ✅ closed | RESOLVED 2026-10-10 ~7:50 AM PT (Claude Code cloud) |
| **#184** | ✅ closed | RESOLVED 2026-10-10 ~6:10 AM PT (Claude Code cloud) |
| **#185** | ✅ closed | RESOLVED 2026-10-14 ~5:21 PM PT (Claude Code cloud, 20261015001336)  |
| **#186** | ✅ closed | CLOSED, NOT A DEFECT 2026-10-10 ~5:20 PM PT (Claude Code cloud) |
| **#187** | ✅ closed | RESOLVED 2026-10-10 ~7:15 PM PT (Claude Code cloud, 20261011020600 + 20261011022500). |
| **#188** | ✅ closed | RESOLVED 2026-10-10 ~10:00 PM PT (Claude Code cloud, 20261011050000). |
| **#189** | ✅ closed | CLOSED BY DECISION 2026-10-23 ~2:50 PM PT (Cowork cloud, autonomous pass) |
| **#190** | 🟡 open | REOPENED 2026-11-14 ~3:40 PM PT (Cowork cloud)  |
| **#191** | ✅ closed | RESOLVED 2026-10-14 ~6:30 PM PT (watch CLOSED 2026-10-17 ~6:49 PM PT |
| **#192** | ✅ closed | RESOLVED 2026-10-17 (Claude Code cloud, docs-refresh pass; found by the All Day roadmap researc… |
| **#193** | ✅ closed | RESOLVED 2026-10-30 ~5:20 PM PT (Claude Code cloud, scheduled weekly read; read-only)  |
| **#194** | ✅ closed | RESOLVED 2026-10-18 ~10:15 AM PT  |
| **#195** | ✅ closed | RESOLVED 2026-10-18 ~3:24 PM PT (Claude Code cloud, 20261018222342)  |
| **#196** | ✅ closed | RESOLVED 2026-10-18 ~5:15 PM PT, verified on production ~5:38 PM PT and gated (Claude Code clou… |
| **#197** | ✅ closed | RESOLVED 2026-10-20 ~7:40 AM PT (Cowork cloud, 20261020142417, UPDATE-only) |
| **#198** | ✅ closed | RESOLVED 2026-10-27 ~7:40 PM PT (Cowork cloud)  |
| **#199** | ✅ closed | RESOLVED 2026-10-20 ~10:45 PM PT (Cowork cloud, 20261021054000, dashboard SQL editor, Trevor ap… |
| **#200** | ✅ closed | RESOLVED 2026-10-20 ~10:47 PM PT (Cowork cloud, 20261021055500, dashboard SQL editor, Trevor ap… |
| **#201** | ✅ closed | RESOLVED 2026-10-20 ~10:35 PM PT (Claude Code cloud, 20261021053313 + docs/audits/2026-10-20-pa… |
| **#202** | ✅ closed | RESOLVED 2026-10-26 ~8:10 PM PT (Cowork cloud; Trevor 8:02 PM "make decisions … take care of al… |
| **#203** | ✅ closed | CLOSED BY DECISION 2026-10-21 ~12:05 AM PT (Cowork cloud, under the standing "make product deci… |
| **#204** | ✅ closed | RESOLVED 2026-10-21 ~6:07 PM PT (Trevor |
| **#205** | ✅ closed | RESOLVED 2026-10-21 ~12:50 PM PT (Claude Code cloud; Trevor chose option (b), "make it a real s… |
| **#206** | ✅ closed | CLOSED BY DECISION 2026-10-21 ~11:40 PM PT (Trevor |
| **#207** | ✅ closed | RESOLVED 2026-10-21 — market Player search is accent-blind for an empty search, in the route (n… |
| **#208** | ✅ closed | RESOLVED 2026-11-13 ~8:05 PM PT (Claude Code cloud; Trevor |
| **#209** | ✅ closed | CLOSED 2026-11-23 ~11:43 AM PT (Claude Code cloud; Trevor |
| **#210** | ✅ closed | CLOSED 2026-11-23 ~11:43 AM PT (Claude Code cloud; Trevor |
| **#211** | ✅ closed | RESOLVED 2026-10-25 ~6:35 PM PT (Cowork cloud, 20261026013559 part B2, dashboard SQL editor wit… |
| **#212** | ✅ closed | RESOLVED 2026-10-26 ~8:45 PM PT  |
| **#213** | ✅ closed | CLOSED 2026-11-05 ~1:39 PM PT (Claude Code cloud; decided under Trevor's delegation  |
| **#214** | ✅ closed | RESOLVED 2026-10-26 ~9:10 PM PT  |
| **#215** | ✅ closed | RESOLVED 2026-10-30 ~8:40 PM PT (Claude Code cloud)  |
| **#216** | ✅ closed | RESOLVED 2026-10-29, migrations applied 10:18–10:25 AM PT (Claude Code cloud; 20261029171852, 2… |
| **#217** | ✅ closed | RESOLVED 2026-10-31 ~4:27 AM PT (Cowork cloud, autonomous pass)  |
| **#218** | ✅ closed | CLOSED 2026-11-23 ~11:41 AM PT (Claude Code cloud; Trevor |
| **#219** | ✅ closed | RESOLVED — and RE-CLOSED on the writer that actually runs, 2026-10-31 ~12:20 PM PT (Cowork clou… |
| **#220** | ✅ closed | RESOLVED 2026-10-31 ~2:05 PM PT (Cowork cloud; Trevor |
| **#221** | ✅ closed | CLOSED 2026-11-08 ~11:30 AM PT (Claude Code, Windows box) |
| **#222** | ✅ closed | RESOLVED 2026-11-01 ~8:45 AM PT (Claude Code cloud; Trevor |
| **#223** | ✅ closed | RESOLVED 2026-11-02 ~8:38 AM PT (Cowork cloud, Chrome; Trevor |
| **#224** | ✅ closed | RESOLVED 2026-11-01 ~10:00 AM PT (Claude Code cloud; Trevor |
| **#225** | ✅ closed | CLOSED BY DECISION 2026-11-02 ~8:48 AM PT (Cowork cloud; Trevor |
| **#226** | ✅ closed | CLOSED 2026-11-05 ~11:50 AM PT (Claude Code cloud, autonomous daytime pass; read-only)  |
| **#227** | ✅ closed | RESOLVED 2026-11-04 ~7:10 AM PT (Cowork cloud)  |
| **#228** | ✅ closed | CLOSED — ACCEPTED RESIDUAL 2026-11-23 ~11:42 AM PT (Claude Code cloud; Trevor: "try to resolve… |
| **#229** | ✅ closed | CLOSED 2026-11-23 ~11:42 AM PT (Claude Code cloud; Trevor |
| **#230** | ✅ closed | RESOLVED 2026-11-04 ~10:45 AM PT (Cowork cloud; Trevor |
| **#231** | ✅ closed | RESOLVED 2026-11-04 ~11:02 AM PT  |
| **#232** | ✅ closed | RESOLVED 2026-11-04 ~5:45 PM PT (Cowork cloud, Trevor's Chrome)  |
| **#233** | ✅ closed | RESOLVED 2026-11-04 ~8:10 PM PT (Cowork cloud; Trevor |
| **#234** | 🟡 open | OPEN — RELABEL COMPUTED, DEFERRED TO AFTER THE GATE — 2026-11-23 ~11:40 AM PT (Claude Code clou… |
| **#235** | ✅ closed | CLOSED 2026-11-23 ~11:35 AM PT (Claude Code cloud; Trevor |
| **#236** | ✅ closed | RESOLVED 2026-11-06 ~7:20 PM PT (Cowork cloud; Trevor from his phone mid-Dame-Time entry |
| **#237** | ✅ closed | CLOSED 2026-11-08 ~8:35 AM PT (Claude Code, Windows box) |
| **#238** | ✅ closed | CLOSED 2026-11-08 ~8:25 AM PT (Claude Code, Windows box) |
| **#239** | ✅ closed | RESOLVED 2026-11-07 ~11:27 PM PT  |
| **#240** | ✅ closed | CLOSED 2026-11-08 ~12:05 PM PT (Cowork cloud; Trevor 12:00 PM |
| **#241** | ✅ closed | RESOLVED 2026-11-13 ~7:25 PM PT (Claude Code cloud; Trevor |
| **#242** | ✅ closed | RESOLVED 2026-11-10 ~7:10 PM PT (Claude Code cloud)  |
| **#243** | ✅ closed | RESOLVED 2026-11-10 ~2:12 PM PT (Claude Code cloud)  |
| **#244** | ✅ closed | RESOLVED 2026-11-09 ~7:35 PM PT (Claude Code, Trevor’s laptop)  |
| **#245** | ✅ closed | RESOLVED 2026-11-10 ~2:25 PM PT (Claude Code cloud)  |
| **#246** | ✅ closed | RESOLVED 2026-11-12 ~10:05 PM PT (Claude Code cloud)  |
| **#247** | ✅ closed | RESOLVED 2026-11-13 ~7:10 PM PT (Cowork cloud; Trevor |
| **#248** | ✅ closed | RESOLVED 2026-11-16 ~10:30 AM PT (Claude Code cloud, scheduled close-out trig_01CScx2oshq9AXFGx… |
| **#249** | ✅ closed | CLOSED 2026-11-23 ~11:34 AM PT (Claude Code cloud; Trevor |
| **#250** | ✅ closed | RESOLVED 2026-11-14 ~6:10 PM PT (Claude Code cloud; Trevor |
| **#251** | ✅ closed | CLOSED 2026-11-14 ~5:20 PM PT (Claude Code cloud; Trevor |
| **#252** | ✅ closed | CLOSED 2026-11-14 ~8:05 PM PT (Claude Code cloud)  |
| **#253** | ✅ closed | CLOSED 2026-11-18 ~5:35 PM PT (Claude Code cloud, autonomous pass)  |
| **#254** | ✅ closed | CLOSED (decided + shipped) 2026-11-14 ~8:15 PM PT (Claude Code cloud; Trevor |
| **#255** | ✅ closed | CLOSED — 2026-11-15 ~10:35 AM PT (Cowork, SQL editor: parked copy dropped as 20261115183513). ⓘ… |
| **#256** | ✅ closed | RESOLVED 2026-11-22 ~12:40 PM PT (Claude Code cloud; Trevor |
| **#257** | ✅ closed | RESOLVED 2026-11-21 ~7:09 PM PT (Claude Code cloud)  |
| **#258** | ✅ closed | CLOSED 2026-11-23 ~11:48 AM PT (Claude Code cloud; Trevor |
| **#259** | ✅ closed | RESOLVED 2026-11-17 ~4:07 PM PT (Claude Code, laptop)  |
| **#260** | ✅ closed | RESOLVED 2026-11-17 ~6:41 AM PT (Claude Code cloud; Trevor |
| **#261** | 🟡 open | OPEN — NARROWED 2026-11-23 ~11:52 AM PT (Claude Code cloud; Trevor: "Keep working through all y… |

<!-- END:ITEM-INDEX -->

0. **Wallet verification — RESOLVED BY REMOVAL 2026-08-08 (Trevor directive): RPC offers NO wallet s…** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#0) on 2026-11-24.

1. **Cart execution — SHELVED 2026-05-24, FRONTEND + API DELETED 2026-08-01 (see the Update at the e…** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#1) on 2026-11-24.

3. **Trade Hub — SHELVED 2026-06-01, DELETED FROM THE TREE 2026-08-01 (see the final Update in this…** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#3) on 2026-11-24.

3b. **Gifting — REMOVED from the frontend 2026-08-01 (READ-ONLY directive, Trevor).** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#3b) on 2026-11-24.

4. **Pinnacle FMV — RESOLVED (verified 2026-05-24; table renamed 2026-06-08, re-verified 2026-06-28).** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#4) on 2026-11-24.

7. **AllDay unmapped_sales backlog — closed** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#7) on 2026-11-24.

9. **Storefront audit pipeline — closed** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#9) on 2026-11-24.

8. **RESOLVED 2026-10-24 ~8:50 AM PT (Cowork cloud; Trevor** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#8) on 2026-11-24.

10. **RESOLVED 2026-09-24 — re-derived: the token migration is effectively DONE, and the 09-23 re-aud…** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#10) on 2026-11-24.

11. **RESOLVED 2026-10-10 ~8:54 AM PT (Claude Code cloud, known-issues triage pass under Trevor's "ma…** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#11) on 2026-11-24.

12. **Blazers trivia — CLOSED 2026-08-17: the file this slot cites does not exist.** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#12) on 2026-11-24.

14. **SHELVED 2026-09-24 (decided under Trevor's delegation) — no standalone monolith split before revenue.** Splitting a 5,169-line `app/api/support-chat/route.ts` or a 2,445-line pack-dist page buys no user-visible change, and every line it moves is a chance to break a pinned honesty contract that the current tests hold in place. So a split happens when a file is touched for a real change, one extraction at a time, under that change's tests. The inventory guard stays as the tripwire. Re-open if a file's size is shown to cause a defect or a build problem. ⓘ Earlier opening follows. — **OPEN (re-audited 2026-09-23) — no Phase-2 split yet; every tracked file grew again (Analytics 1,927, pack-dist 2,445, support-chat 5,169); the inventory guard passes.** ⓘ Original opening follows. — **Monolith page refactor — ⚠ ALL THREE TARGETS ARE MIS-POINTED THE SAME WAY, and one bigger file is untracked. Re-derived 2026-08-24.** The Phase-1 finding still holds, but **every filename and every number in this entry is now wrong**, because all three pages became thin shells and their bodies moved to `*Client.tsx` siblings — the same 2026-08-17 move as #10:

    | this entry said | that file today | where the body actually is |
    |---|---|---|
    | `collection/page.tsx` **~1,600** | **11 lines** | `CollectionTabClient.tsx` **1,347** |
    | `sniper/page.tsx` **~1,705** | **28 lines** | `SniperClient.tsx` **1,804** |
    | `analytics/page.tsx` **~1,754** | **11 lines** | `CollectionAnalyticsClient.tsx` **1,840** |

    ⚠ **Two of the three GREW** (+99, +86) while the entry recorded them shrinking — **a size claim that is only ever re-measured downward is not a measurement.** The **Phase 2** guidance is unchanged and still right: breaking the main interactive component into per-`useState`-cluster children is **medium-risk, requires rendered-DOM validation across all 5 collections, and must NOT be attempted in one commit** (plan: `docs/audits/refactor-plan-monolith-pages-2026-05.md`). Pure, unit-testable logic can still be peeled off safely.

    🚨 **AND THE ENTRY'S POPULATION IS A CURATED LIST, SO IT IS SILENT ABOUT THE BIGGEST ONE.** `app/(collections)/[collection]/pack/dist/[distId]/page.tsx` is **2,384 lines** — larger than any of the three above — is a **SERVER** page with no client sibling, and appears in no monolith entry. ⚠ **It is also unmeasured by BOTH coverage gates:** the primary gate includes `lib/**` + `app/**/route.ts(x)` and the components gate `components/**` + `app/**/*Client.tsx`, so **`app/**/page.tsx` is in neither** — there is exactly one hand-added exception (`app/insights/squeeze-check/page.tsx`). It is not unguarded (`server-page-data-access-ratchet` and `insights-server-pages-bound-their-reads` read it statically), but **no gate measures whether its branches run.** ➡ **Derive this population from the tree by size, not from a list — that is why the largest instance went unnamed.**

    🚨 **THAT INSTRUCTION WAS FOLLOWED BY NOBODY FOR A FORTNIGHT, SO IT IS A GUARD NOW — `__tests__/monolith-inventory-is-derived-from-the-tree.test.ts` (2026-09-07).** It walks `app/` + `components/` + `lib/` and requires every `.ts(x)` file **≥ 1,500 lines** to be NAMED somewhere in this file. ⭐ **The register is the SUPPRESSION list: naming a file is the entire requirement** — *"acknowledged, not scheduled"* passes. What must not recur is a file this size being invisible. ⛔ **It deliberately does NOT pin line counts** — every figure here is a dated sample, and a test asserting "1,849 lines" would red on every edit and train people to bump numbers without reading them. It prints the full inventory on failure so these numbers can be re-derived by hand.

    **Its first run caught THREE files named nowhere in this register**, a fortnight after the note above told the next reader to go looking:

    | file | lines (2026-09-07) | note |
    |---|---|---|
    | `app/api/fmv-recalc/route.ts` | **2,334** | CLAUDE.md discusses the *route's cost*; the FILE was in no monolith entry |
    | `app/api/sniper-feed/route.ts` | **2,029** | — |
    | `components/profile/TrophyPickerModal.tsx` | **1,632** (2026-11-08) | crossed 1,500 with the multi-pick change (Dame Time feedback); acknowledged, not scheduled |
    | `app/moment/[id]/page.tsx` | **1,953** | ⚠ **a SERVER page, larger than two of the three tracked above, and — exactly like the pack-dist page — measured by NEITHER coverage gate.** The identical shape, missed the identical way. |

    ⚠ **AND ALL THREE TRACKED FILES GREW AGAIN since the 08-24 re-derivation** — `CollectionTabClient` 1,347 → **1,416**, `SniperClient` 1,804 → **1,849**, `CollectionAnalyticsClient` 1,840 → **1,875**. ⭐ That is the second consecutive re-measurement in which every number moved UP, against an entry that once recorded them shrinking. **The trend is the finding; the individual numbers are dated samples.** ⓘ The largest file in the repo, `app/api/support-chat/route.ts` (**4,526**), and `DashboardClient.tsx` (**2,836**, item #10) were already named and are unchanged in status.

    ⓘ **One near-miss worth recording, because it nearly became a false finding.** Reading the components config with a regex, I concluded `app/**` was absent from its `coverage.include` and that the 08-17 move had therefore failed its own purpose. **It has a blanket `app/**/*Client.tsx` glob** (added precisely so client bodies under `app/` are measured), and the coverage REPORT shows those files. **The config was 180 lines of commentary and my regex matched the wrong `include:`.** ➡ **Check the instrument's OUTPUT, not its configuration.**

    ↳ **2026-11-24 (rpc-context-hygiene) — the monolith inventory's other half moved with the closed items.** These files are over the 1,500-line threshold and were named only inside closed items, whose full text now lives in [known-issues-archive.md](known-issues-archive.md); they stay acknowledged, not scheduled: `app/(collections)/[collection]/edition/[slug]/page.tsx` (#17, #249), `app/api/market/route.ts` (#57, #129, #131), `app/api/sentinel/route.ts` (#25, #73, #77, #104, #117), `app/api/smoke-test/route.ts` (#34, #45, #57, #115), `app/api/wallet-search/route.ts` (#18), `lib/chains/flow/wallet-backfill-helpers.ts` (#31, #113, #138, #158, #219), `lib/seo.ts` (#71).

15. **livetoken-portfolio.json fixtures — closed** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#15) on 2026-11-24.

17. **CLOSED 2026-10-17 by decision (Claude Code cloud; Trevor** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#17) on 2026-11-24.

18. **RESOLVED 2026-10-10 ~11:53 AM PT — closed** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#18) on 2026-11-24.

19. **RESOLVED 2026-08-22 — jobid 70 moved to 23:35Z via a migration; no grant was made or needed.** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#19) on 2026-11-24.

26. **RESOLVED 2026-09-24 — no flap on Large.** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#26) on 2026-11-24.

26b. **(historical — the original filing, superseded by 26 above; kept because its evidence is what id…** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#26b) on 2026-11-24.

20. **RESOLVED NEGATIVELY 2026-08-31, atlas-proxy deployed and Cloudflare egress is Atlas-WAF-blocked** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#20) on 2026-11-24.

21. **RESOLVED IN REPO 2026-09-23 — closed** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#21) on 2026-11-24.


22. **RESOLVED 2026-10-26 ~8:45 PM PT — closed** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#22) on 2026-11-24.

23. **CLOSED 2026-09-08 — RE-READ FROM THE DETECTOR'S OWN LOG, and the number is 6, not 25, with ever…** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#23) on 2026-11-24.

24. **RESOLVED 2026-08-22 — all 6 closed.** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#24) on 2026-11-24.

25. **RESOLVED 2026-09-25 ~9:40 PM PT — closed** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#25) on 2026-11-24.

27. **RESOLVED 2026-09-02 — jobs 352/353/354 re-registered at 300s via cron.alter_job from the Cowork…** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#27) on 2026-11-24.

28. **RESOLVED — code fix 2026-08-23 (9b862dc8), and VERIFIED IN PRODUCTION AGAINST THE DATABASE 2026…** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#28) on 2026-11-24.

29. **CLOSED 2026-09-23 — premise gone: jobid 55 was unscheduled 09-04, so the lane has no caller; wh…** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#29) on 2026-11-24.

30. **CLOSED — ACCEPTED 2026-09-24 (decided under Trevor's delegation): this item's 6-a-day threshold…** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#30) on 2026-11-24.

33. **RESOLVED 2026-10-10 ~3:45 PM PT (Claude Code cloud, decided under Trevor's "use your best judge…** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#33) on 2026-11-24.
32. **CLOSED 2026-09-20 — Trevor saved the merged rpc-cron-ops card at 9:48 PM PT 09-19; verified fro…** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#32) on 2026-11-24.

31. **CLOSED 2026-09-08 — SUPERSEDED BY #53, and confirmed by a live read rather than by trusting tha…** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#31) on 2026-11-24.


34. **RESOLVED 2026-10-10 ~8:54 AM PT (Claude Code cloud, known-issues triage pass under Trevor's "ma…** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#34) on 2026-11-24.

35. **CLOSED 2026-09-24 ~8:50 AM PT — closed** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#35) on 2026-11-24.
36. **RESOLVED 2026-09-07 — the 08-30 body's cost read as a 3.4-day flow is 33 % / 91 % of the T1 thr…** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#36) on 2026-11-24.

37. **RESOLVED 2026-08-27 — VERIFIED DETERMINISTICALLY, not by a lucky green run. Filed 2026-08-26 —…** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#37) on 2026-11-24.

38. **CLOSED 2026-09-08 BY THE PAUSE — closed** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#38) on 2026-11-24.

39. **RESOLVED 2026-09-24 — the Large compute tier (09-20) plus the warmer closed it.** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#39) on 2026-11-24.


40. **CLOSED 2026-09-02 — the one observation this item was waiting on is in, over a WEEK not a tick:…** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#40) on 2026-11-24.


41. **CLOSED 2026-09-01 by re-derivation — closed** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#41) on 2026-11-24.


42. **CLOSED 2026-09-23 — premise gone: 0 failed pg_cron runs of 27,262 since 09-21 00:00 PT (busy 2.…** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#42) on 2026-11-24.

43. **CLOSED — POLICY DECIDED 2026-09-24 (under Trevor's delegation).** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#43) on 2026-11-24.
44. **CLOSED 2026-08-27 (Trevor’s call) — closed** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#44) on 2026-11-24.

45. **RESOLVED 2026-08-28 (register was stale — closed** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#45) on 2026-11-24.

46. **RESOLVED 2026-08-29 — the root cause was DEFECT 3 (the template-interpolation desync), it is fi…** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#46) on 2026-11-24.


47. **CLOSED 2026-09-01 — THE EXPERIMENT'S FALSIFIER IS ANSWERED AND NOT MET: the kills stopped. ⚠ Bu…** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#47) on 2026-11-24.

48. **CLOSED 2026-09-23 — wallet backfill completes every dispatch (1,042 of 1,042 over 73 h) and the…** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#48) on 2026-11-24.

49. **CLOSED — ACCEPTED 2026-09-24 on a fresh measurement.** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#49) on 2026-11-24.

50. **CLOSED — EXTENDED 2026-09-24 8:06 / 8:09 PM PT to All Day and Golazos (20260925030613, 20260925…** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#50) on 2026-11-24.

51. **RESOLVED 2026-10-10 ~8:54 AM PT (Claude Code cloud, known-issues triage pass under Trevor's "ma…** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#51) on 2026-11-24.

52. **RESOLVED 2026-10-10 ~8:54 AM PT (Claude Code cloud, known-issues triage pass under Trevor's "ma…** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#52) on 2026-11-24.

53. **RESOLVED 2026-08-30 — TIER 2 RUNS: the eszip parse-mode census read 38/38 deployed bundles, and…** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#53) on 2026-11-24.

54. **CLOSED 2026-09-23 — the input gate is live (runs of 26–283 ms, gated, ok), so the waste is gone…** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#54) on 2026-11-24.

55. **RESOLVED 2026-09-23 — both disabled Routines DELETED** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#55) on 2026-11-24.



---


56. **RESOLVED 2026-09-27 ~11:00 PM PT — closed** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#56) on 2026-11-24.
57. **RESOLVED 2026-09-02 (same day it was opened) — closed** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#57) on 2026-11-24.

58. **RESOLVED BY MEASUREMENT 2026-10-25 ~7:20 PM PT (Cowork cloud, read-only) — closed** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#58) on 2026-11-24.

59. **RESOLVED 2026-09-06 (same day) — closed** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#59) on 2026-11-24.

60. **CLOSED — RISK ACCEPTED 2026-09-23.** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#60) on 2026-11-24.

61. **RESOLVED 2026-10-10 ~8:54 AM PT (Claude Code cloud, known-issues triage pass under Trevor's "ma…** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#61) on 2026-11-24.
62. **CLOSED 2026-09-23 — a reference note, not a defect: mobile-sweep.mjs and mobile-layout.spec.ts…** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#62) on 2026-11-24.

63. **CLOSED 2026-09-23 — Candy has Overview, Market, Collection and Analytics tabs plus entity pages…** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#63) on 2026-11-24.

64. **RESOLVED 2026-09-25 ~10:30 PM PT — closed** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#64) on 2026-11-24.

65. **RESOLVED 2026-10-10 ~9:50 AM PT — closed** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#65) on 2026-11-24.

66. 🟠 **PARTLY DONE — RE-GATED 2026-11-23 ~11:40 AM PT (Claude Code cloud; Trevor: "try to resolve these still open"): outreach now waits on the Top Shot GATE PASS, not on #234's relabel.** The trigger's accuracy half is met twice: HIGH 80.1 (11-09) and 83.3 (11-16) ≥ 75. Its relabel half is moot for outreach, because labels are never shown (Concierge rule 3), and #234's relabel is deliberately deferred until after the gate. **New trigger:** the 4-week realised-sales gate passes (`go-live-2026-09.md` §6 item 5; weeks 3–4 read Mon 11-30 and Mon 12-07) plus its drop-day leg. Then the order stands: the Flow ecosystem directory listing, the public README (already links the site), then a community tools thread. **Outreach is Trevor's to send**: external, under his name. ⓘ Previous status follows. — 66. 🟠 **PARTLY DONE — 2026-11-16 ~9:20 PM PT note (Claude Code cloud): the accuracy HALF of the re-open trigger is MET — `fmv_accuracy_weekly` Top Shot HIGH within ±25 read 75.5 (wk 11-02) and 80.1 (wk 11-09). The other half, #234's relabel, has not landed (earliest after the Mon 11-23 run), so outreach stays held.** — 🟠 **PARTLY DONE — 2026-11-13 ~8:20 PM PT (Claude Code cloud; Trevor: "make these decisions yourself") — DECIDED: external-link outreach stays HELD by the accuracy gate, now with a measurable trigger.** Asking directories and communities to point collectors at our prices before those prices measurably hold up would spend RPC's one first impression; the roadmap thesis (08-03) keeps growth tactics off until the data beats what collectors already use. **Re-open when** #234's relabel has landed and `fmv_accuracy_weekly` shows Top Shot HIGH ≥ 75 % within ±25 for two consecutive weeks. Then the order is: the Flow ecosystem directory listing, the public README (already links the live site), then a community tools thread. Nothing here needs code. ⓘ Earlier text follows. — **OPEN, NEEDS TREVOR, PARTLY DONE (re-read 2026-10-28) — every code item is DONE; the 10-28 Search Console re-read is DONE (49.4K indexed, up from 31.8K on 10-03; 28 d 60 clicks / 2.15K impressions / pos 12.5; Product snippets and Breadcrumbs 0 invalid; the 46 `/profile/0x…` 404 fossils now 308 to `/share/<wallet>`; full read in docs/strategy/seo-2026-09-06-search-console-read.md). What remains is external links, held by the accuracy gate.** ⓘ 10-14 opening: every code item is DONE; what remains is external links (held by the accuracy gate) and the Search Console re-read scheduled 2026-10-28. ⓘ **10-14 pass (ledger, 10-14 SEO entries; strategy doc §"2026-10-14 pass"):** sitemap split into 9 children (Panini edition shards 5–8, a 50,000-URL per-file refusal, segment-3 `maxRows` 60K → 250K — both cliffs were days out); one-edition set pages (677) out of the sitemap; "editions with no sales and no holders" measured EMPTY; "wnba gold slot" is a BetMGM casino game (no page); "premiumchance" → `/blog/premium-chance-hit-vs-chance-hit`; site/Candy/Panini/analytics metadata derived or corrected; tab and blog share images; Pinnacle pin titles + breadcrumbs; `/insights` hub ItemList. Live audits: 42 pages structural, 120 random sitemap URLs health — clean. ⚠ The ~10-06 title click-rate re-read below was never recorded; it folds into the 10-28 re-read. ⓘ Prior opening (09-23): external links (Trevor) still pending; sitemap pruning and query pages partly done; the title click-rate re-read is due ~10-06. ⓘ Original opening follows. — 🟡 **OPEN, NEW 2026-09-06 — SEO: the site has ZERO external links, so 31K indexed pages rank on page 3 (45 clicks lifetime).** Search Console read 09-06 (`docs/strategy/seo-2026-09-06-search-console-read.md`; dated samples): 3.77K impressions / 45 clicks since 05-30, position 22; **External links: 0, Top linking sites: none**. Three technical findings fixed the same day (commit "seo: search console"): `robots.txt` blocked `/_next/static` so Googlebot rendered blind (1,449 chunk URLs) → carve-out; `/moment/<edition uuid>` duplicated the edition page under ~11K URLs → 301 + out of the sitemap; every sales-table wallet cell linked to `/profile/<address>`, a URL that 404s (865 noindex + 302 404) → analyzer link with `rel=nofollow`. **What remains is not code:** (1) links — Flow ecosystem directories, the public repo README, community tools threads, a Product Hunt / Indie Hackers launch (⛔ never leading with the Team Captain designation — IYKYK, Trevor 09-06); (2) query-matched pages for the intents already showing ("account value calculator", "wnba gold slot", "premiumchance", "ufc strike value"); (3) prune the sitemap (34K URLs; 2,827 discovered-not-indexed shells) to pages that could be a best answer; (4) invert internal linking (`/pricing` has 27,566 footer links; entity pages one each) — related-editions blocks; (5) ✅ **DONE 2026-09-06 evening** — the dollar figure is out of edition `<title>`s (FMV-independent title, value moved to the description; pinned as an ABSENCE over all five entity helpers, the two honesty cases INVERTED not deleted). **Also shipped out of (2):** all five UFC tabs were advertising a LIVE market in their metadata — "live FMV", "daily market pulse" and, on the sniper tab, "Live deals below FMV" — on a collection whose Flow market closed 2026-05-13. `pageMetadata` now serves closed-market copy derived from `closedMarket()` (per TAB, so any future closure is covered without a second list), guarded by a ban at zero over `CLOSED_MARKETS × PUBLIC_TAB_PAGES` with a no-change control on live collections. ⓘ Not covered by that guard and deliberately not swept in: `collectionLayoutMetadata`'s UFC root copy still says "sniper deals" (it carries its own Aptos-migration disclosure). **09-07 (this session, same evening):** (4) partly shipped — `/pricing` out of the footer, sitemap and index; `get_edition_related` (`20260907005829`, pinned) gives every non-Pinnacle edition page a *More from this player / set* block; parallels cards link to the canonical edition URL, not `/moment/<uuid>`; (2) partly — account-value board retitled *Account Value Calculator — Free Value Tracker*, pack-dist pages titled *Odds, Pulls & EV* and `Retail $0.00` withheld. ⚠ On (5), shipped concurrently in `9909fb8`: one owed measurement — edition-page CTR for 30 days before vs after the figure left the title (a price in a SERP title is plausibly the click magnet); if it fell, the figure goes back in a stable rounded form. ✅ **MEASURED 2026-11-05 ~4:33 PM PT (Claude Code cloud, Search Console via Trevor's Chrome): not reverting.** The first month after did fall (edition pages 13 → 2 clicks on ~1.1K impressions while the rest of the site rose), but the next month edition pages reached 3.0 % CTR (54 / 1.8K), above the pre-change 1.2 %, mostly Panini edition pages with the same price-free titles; Top Shot edition pages alone 8/825 → 1/415 — too few clicks to attribute. Table + re-open condition: `docs/strategy/seo-2026-09-06-search-console-read.md` item 5. 🚨 **And verifying that metadata ship in production found the same false claim one layer in, in the BODY:** `/ufc/sniper`'s server-rendered subtitle read *LIVE DEALS BELOW ADJUSTED FMV* on a market closed since 13 May 2026. `MarketplaceStatusBanner` is on that page and does not cover it — it resolves client-side, so the shell a reader or crawler gets first carries the false line alone and a failed banner fetch never corrects it. Now `lib/sniper/header-copy.ts` → `sniperSubtitle()`, derived from `closedMarket()` and checked before the Pinnacle branch, guarded over `CLOSED_MARKETS` × both branches with a no-change control and a source-level ban on re-inlining the literal. ⭐ **The transferable lesson: a metadata fix is not a page fix — verify the rendered body, not the `<head>` you changed.** Owner: Trevor for (1); code for the rest of (2), (3), (4). Watch the GSC buckets named in the strategy doc; re-read Performance ~10-06.


67. **CLOSED — DECIDED 2026-09-24 (under Trevor's delegation): no full-budget historical walk.** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#67) on 2026-11-24.

68. **CLOSED 2026-09-08 — rows drained (33,000, backed up), the per-partition constraint shipped and…** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#68) on 2026-11-24.

69. **RESOLVED 2026-09-11, RETRACTED AS A DEFECT — closed** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#69) on 2026-11-24.


70. **RESOLVED 2026-10-10 ~10:05 PM PT (Claude Code cloud, code 0a763bf0e) — closed** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#70) on 2026-11-24.
71. **CLOSED — ACCEPTED 2026-09-24.** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#71) on 2026-11-24.

72. **RESOLVED 2026-10-10 ~8:54 AM PT (Claude Code cloud, known-issues triage pass under Trevor's "ma…** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#72) on 2026-11-24.

73. **RESOLVED 2026-10-10 ~8:54 AM PT (Claude Code cloud, known-issues triage pass under Trevor's "ma…** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#73) on 2026-11-24.

74. **RESOLVED 2026-10-10 ~9:21 AM PT (Claude Code cloud); the MISSED HALF closed 2026-10-14 ~7:35 PM…** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#74) on 2026-11-24.

75. **CLOSED 2026-09-20 (PT) — ITS SUBJECT IS GONE AND ITS ARMED RE-CHECK IS ANSWERED, THOUGH NOT BY…** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#75) on 2026-11-24.
76. **RESOLVED 2026-10-13 ~6:40 AM PT — closed** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#76) on 2026-11-24.

77. **CLOSED 2026-09-23 — email and Telegram both deliver on 88 of 88 sentinel runs since 09-20 9:04…** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#77) on 2026-11-24.

78. **CLOSED 2026-09-12 (PT) — THE LANE IS HEALTHY, ESTABLISHED WITH A POSITIVE CONTROL RATHER THAN B…** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#78) on 2026-11-24.

79. **RESOLVED 2026-10-10 ~11:12 AM PT (decided under Trevor's delegation) — closed** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#79) on 2026-11-24.
80. **RESOLVED 2026-10-10 ~8:54 AM PT (Claude Code cloud, known-issues triage pass under Trevor's "ma…** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#80) on 2026-11-24.

81. **RETIRED 2026-09-23 (decided) — closed** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#81) on 2026-11-24.

82. **CLOSED 2026-09-23 — impossible_parallel_serials has read 0 every day 09-15→09-23 across 35 of 3…** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#82) on 2026-11-24.

83. **RESOLVED 2026-09-24 — the existing rows are backfilled (decided under Trevor's delegation).** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#83) on 2026-11-24.

84. **RESOLVED 2026-10-10 ~8:54 AM PT (Claude Code cloud, known-issues triage pass under Trevor's "ma…** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#84) on 2026-11-24.


85. **RESOLVED 2026-10-10 ~11:18 AM PT (decided under Trevor's delegation) — closed** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#85) on 2026-11-24.


86. **RESOLVED 2026-09-12 (same hour it was found) — closed** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#86) on 2026-11-24.


87. **RESOLVED 2026-09-12 (same day) — closed** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#87) on 2026-11-24.

88. **RESOLVED 2026-10-10 ~10:15 AM PT — closed** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#88) on 2026-11-24.

89. **CLOSED 2026-09-12 (PT) — THE 4 MB CAP CAN NO LONGER STRIP PINNACLE ART, MEASURED IN PRODUCTION…** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#89) on 2026-11-24.

90. **RETIRED 2026-09-24 (decided under Trevor's delegation) — closed** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#90) on 2026-11-24.

91. **CLOSED — ACCEPTED 2026-09-24 (option c, measured).** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#91) on 2026-11-24.

92. **RESOLVED 2026-09-12 (PT), same night it was filed — closed** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#92) on 2026-11-24.

93. **RESOLVED 2026-10-10 ~8:54 AM PT (Claude Code cloud, known-issues triage pass under Trevor's "ma…** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#93) on 2026-11-24.
94. **RESOLVED 2026-10-10 ~8:25 AM PT (Cowork cloud) — closed** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#94) on 2026-11-24.

95. **CLOSED 2026-09-13 (PT) — every half is now answered: the COUNT measured, the PRICE measured at…** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#95) on 2026-11-24.

96. **CLOSED 2026-09-13 (PT) — SHIPPED: THE PROFILE OG CARD NAMES ITS MOMENTS, AT EVERY GRID SIZE. Fi…** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#96) on 2026-11-24.

97. **CLOSED THE DAY IT BIT FOR THE THIRD TIME, 2026-09-12 (PT) — closed** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#97) on 2026-11-24.

98. **SHELVED 2026-09-24, a follow-on of #81's decision.** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#98) on 2026-11-24.

99. **RESOLVED 2026-09-24 — the floor is back at 2023-11-08 (#109's filtered indexes landed), and the…** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#99) on 2026-11-24.

100. **CLOSED 2026-09-23 — the cron-job.org :04 trigger is live: 29–31 ok sweeps a day since 09-14, ma…** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#100) on 2026-11-24.
101. **RESOLVED 2026-10-10 ~11:31 AM PT (datapoint 2026-10-14 ~6:52 PM PT) — closed** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#101) on 2026-11-24.

102. **RESOLVED 2026-10-10 ~11:59 AM PT (decided under Trevor's delegation).** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#102) on 2026-11-24.


103. **CLOSED 2026-09-23 — retry jobid 490 filled 09-18 and 09-19 after primary timeouts; every date 0…** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#103) on 2026-11-24.

104. **CLOSED — ACCEPTED 2026-09-24 (the 09-13 decision re-confirmed on Large).** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#104) on 2026-11-24.



105. **CLOSED 2026-09-13 (PT), the day Cowork filed it — closed** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#105) on 2026-11-24.

106. **CLOSED 2026-09-13 (PT), same session it was found — closed** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#106) on 2026-11-24.





107. **CLOSED 2026-09-23 — the retry storm is gone: 449 of 449 fmv-recalc ticks finished (72 h to 09-2…** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#107) on 2026-11-24.

108. **CLOSED — ACCEPTED 2026-09-24.** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#108) on 2026-11-24.

109. **RESOLVED 2026-09-23 — the three claimable filtered indexes are built and the floor is back at 2…** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#109) on 2026-11-24.

110. **CLOSED 2026-09-23 — exit met: runs 09-14→09-23 wrote 3,053 base→parallel and 0 parallel→own-bas…** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#110) on 2026-11-24.

111. **CLOSED 2026-09-13 4:2x PM (PT), the same afternoon — closed** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#111) on 2026-11-24.

112. **RESOLVED 2026-09-13 (PT) — closed** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#112) on 2026-11-24.
113. **RESOLVED 2026-10-10 ~8:54 AM PT (Claude Code cloud, known-issues triage pass under Trevor's "ma…** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#113) on 2026-11-24.

114. **RESOLVED 2026-10-20 ~10:05 AM PT (Cowork cloud, laptop linked; Trevor** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#114) on 2026-11-24.

115. **CLOSED 2026-09-19 (PT) — THE PROPERTY IS WATCHED, BY THREE BAN-AT-ZERO ARMS, AND THE LAST ONE S…** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#115) on 2026-11-24.

116. **RESOLVED 2026-10-10 ~8:54 AM PT (Claude Code cloud, known-issues triage pass under Trevor's "ma…** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#116) on 2026-11-24.

117. **CLOSED 2026-09-23 — withdrawn filing, kept as a record; on 09-23 the arm shows 7 degraded and 0…** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#117) on 2026-11-24.

118. **RESOLVED 2026-10-10 ~11:05 AM PT — closed** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#118) on 2026-11-24.

119. **RESOLVED 2026-09-24 — the write-side guard is now LIVE in the function, not only in the table.** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#119) on 2026-11-24.

120. **RESOLVED 2026-10-10 ~8:54 AM PT (Claude Code cloud, known-issues triage pass under Trevor's "ma…** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#120) on 2026-11-24.

121. **CLOSED 2026-09-20 (PT) — IT NO LONGER REPRODUCES, AND THE MECHANISM WAS THE VISIBILITY MAP, NOT…** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#121) on 2026-11-24.

122. **RESOLVED 2026-09-18 12:0x PM PT (was OPEN, filed ~7:45 AM PT)** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#122) on 2026-11-24.

> ⚠ **THIS IS THE MAY-2026 RESOLVED SET, AND IT IS CLOSED TO NEW ENTRIES (noted 2026-08-27).** A newly resolved item does **NOT** move here: it keeps its number under `### Open` and the STATUS INDEX at the top of that section marks it `✅ closed`.
>
> ⛔ **That convention exists because moving one broke it.** Item **#8** was filed under this heading while REGRESSED, and its own text records the consequence — *"it sat under a Resolved heading, so anyone enumerating the Open list never saw it"*. Item numbers are cited by the ledger, `focus.md`, inbox filings, CLAUDE.md and migration record files, so **moving an item silently breaks every one of those references as well.**

- **fmv-recalc silent stall — RESOLVED 2026-05-25 (`dd84526`).** Stalled 2026-05-24 22:03 → 2026-05-25 14:53. Root cause: unchunked `.in("edition_id", …)` in `/api/fmv-recalc` Step 3 + the Step 2a-bis meta fetch blew past PostgREST's URL cap on a ~1,100-edition page; supabase-js surfaced it as a non-throwing `deleteError` and `if (deleteError) return` exited `after()` before `log_pipeline_run` — route crashed silently inside the lambda while `topshot-listing-cache` still logged `fmv_recalc_called: true`. Fix chunked both `.in()` sites at 500 (matching the file's other 3 delete sites) and added `log_pipeline_run` to the fatal-catch + Step 3 error paths so future silent stalls surface in `pipeline_runs`. Cron and chain were never at fault.
- **#2 Sentry error capture** — `NEXT_PUBLIC_SENTRY_DSN` confirmed set in Vercel env + redeployed. SDK wired (org `rip-packs-city`, project `javascript-nextjs`).
- **#3 Flowty event indexer "regression"** — not a bug; Flowty's marketplace shut down (see Platform changes above).
- **#5 AllDay/UFC mis-categorized editions** — only 8 stray editions remain under the TopShot collection_id (all `disney_pinnacle`), not ~454. Effectively resolved.
- **#6 WarmupContext key mismatch** — `WarmupContext.tsx` now prefetches `/api/packs` into the key `PackPageClient` reads.
- **#13 `flowty_archive` growth** — resolved (option-B prune + `VACUUM FULL`; total DB 13.8 → 6.5 GB).
- **#16 `flow test` CI gating** — `.github/workflows/ci.yml` gates `tsc` + the Cadence harness. The `cadence-lint` job's missing `flow dependencies install` step was fixed 2026-05-22; it runs `continue-on-error` (non-blocking) pending a confirmed green run.


---

123. **RESOLVED 2026-09-27 ~11:40 PM PT (thread close) — closed** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#123) on 2026-11-24.

124. **CLOSED 2026-09-19 (opened 2026-09-18) — closed** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#124) on 2026-11-24.

125. **CLOSED 2026-09-23 (PT) ON ITS OWN FIRST-TICK FALSIFIER — closed** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#125) on 2026-11-24.
126. **RESOLVED 2026-09-20 ~11:5x AM PT — closed** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#126) on 2026-11-24.


127. **CLOSED — ACCEPTED 2026-09-24 after sizing AND tracing the exposed reader; no eviction.** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#127) on 2026-11-24.

128. **RESOLVED 2026-10-10 ~8:54 AM PT (Claude Code cloud, known-issues triage pass under Trevor's "ma…** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#128) on 2026-11-24.

129. **RESOLVED 2026-09-23 (PT) — closed** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#129) on 2026-11-24.

130. **RESOLVED 2026-09-20 6:20 PM PT (the ledger's 09-20 "GATE-KEY ROTATION FINALLY COMPLETES" entry** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#130) on 2026-11-24.

131. **RESOLVED 2026-09-23 5:35 PM PT — closed** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#131) on 2026-11-24.

132. **CLOSED — ACCEPTED 2026-09-23: board row links stay as they are.** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#132) on 2026-11-24.

133. **CLOSED 2026-09-23 ~8:40 PM PT — closed** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#133) on 2026-11-24.

134. **RESOLVED BY DECISION 2026-09-27 ~11:40 PM PT (thread close) — closed** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#134) on 2026-11-24.


135. **CLOSED 2026-09-24 3:35 PM PT — closed** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#135) on 2026-11-24.

136. **CLOSED 2026-09-25 ~7:20 AM PT — closed** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#136) on 2026-11-24.
137. **CLOSED 2026-09-25 ~7:30 AM PT (Trevor decided (a) and (b) 09-25) — closed** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#137) on 2026-11-24.
138. **CLOSED — DECIDED 2026-09-25 ~7:25 AM PT: no mega-wallet id source is built now; nothing user-fa…** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#138) on 2026-11-24.

139. **RESOLVED — every pair resolved against NBA.com and NFL.com and applied 2026-09-25 ~2:30 PM PT:…** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#139) on 2026-11-24.

140. **RESOLVED 2026-09-25 ~8:15 PM PT — closed** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#140) on 2026-11-24.

141. **RESOLVED 2026-09-25 ~7:05 PM PT — closed** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#141) on 2026-11-24.

142. **RESOLVED 2026-09-27 ~11:10 PM PT — closed** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#142) on 2026-11-24.

143. **RESOLVED 2026-10-10 ~9:05 AM PT (Cowork cloud, decided under Trevor's "make decisions on these…** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#143) on 2026-11-24.
144. **RESOLVED 2026-10-04 8:55 AM PT — closed** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#144) on 2026-11-24.

145. **RESOLVED 2026-09-27 ~11:20 PM PT — closed** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#145) on 2026-11-24.

146. **✅ RESOLVED 2026-09-26 ~9:05 AM PT — closed** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#146) on 2026-11-24.
147. **CLOSED 2026-10-03 ~8:05 PM PT (Claude Code cloud) — closed** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#147) on 2026-11-24.
148. **CLOSED 2026-09-26 ~8:50 AM PT — closed** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#148) on 2026-11-24.
149. **RESOLVED 2026-10-10 ~8:25 AM PT (Cowork cloud) — closed** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#149) on 2026-11-24.
150. **✅ RESOLVED 2026-09-26 ~2:55 PM PT — closed** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#150) on 2026-11-24.

151. **✅ RESOLVED 2026-09-27 ~9:40 AM PT — closed** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#151) on 2026-11-24.
152. **✅ RESOLVED 2026-09-27 ~10:48 AM PT — closed** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#152) on 2026-11-24.
153. **✅ RESOLVED 2026-09-27 ~10:20 AM PT — closed** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#153) on 2026-11-24.
154. **✅ RESOLVED 2026-09-27 ~11:00 AM PT — closed** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#154) on 2026-11-24.
155. **RESOLVED 2026-09-27 — Disney Pinnacle render FMV was a WAP-centred trimmed average that dropped…** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#155) on 2026-11-24.
156. **RESOLVED 2026-09-28 — Disney Pinnacle sales of SERIALISED pins were missing their serial number…** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#156) on 2026-11-24.
157. **RESOLVED 2026-09-28 — Disney Pinnacle pack EV was computed per SUB-DISTRIBUTION of a drop, so a…** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#157) on 2026-11-24.

158. **RESOLVED 2026-09-28 — A refresh STARVATION LOOP: a stats-only reconciler stamped seeded_wallets…** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#158) on 2026-11-24.
159. **RESOLVED 2026-09-28 — 25,793 Disney Pinnacle sales were counted TWICE: studio-history rows dupl…** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#159) on 2026-11-24.
160. **RESOLVED 2026-10-11 ~10:50 AM PT (Claude Code)** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#160) on 2026-11-24.
161. **RESOLVED 2026-09-30 ~5:40 PM PT — closed** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#161) on 2026-11-24.
162. **RESOLVED 2026-09-29 (Trevor** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#162) on 2026-11-24.
163. **RESOLVED 2026-10-03 (PT) — closed** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#163) on 2026-11-24.
164. **RESOLVED 2026-10-03 (PT) — closed** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#164) on 2026-11-24.
165. **RESOLVED 2026-09-30 ~7:34 PM PT — closed** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#165) on 2026-11-24.
166. **✅ RESOLVED 2026-10-02 ~9:57 PM PT (decided under Trevor's delegation** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#166) on 2026-11-24.
167. **RESOLVED 2026-10-10 ~9:17 AM PT (Claude Code cloud):** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#167) on 2026-11-24.
168. **RESOLVED 2026-10-03 ~11:30 AM PT — closed** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#168) on 2026-11-24.

169. **RESOLVED 2026-10-10 ~5:59 AM PT (Claude Code cloud)** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#169) on 2026-11-24.

170. **RESOLVED 2026-10-04 ~7:35 AM PT (Cowork cloud, Supabase SQL editor in Trevor's Chrome; MCP appl…** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#170) on 2026-11-24.
171. **RESOLVED 2026-10-10 ~11:35 AM PT (decided under Trevor's delegation) — closed** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#171) on 2026-11-24.
172. **SHELVED 2026-10-17 by decision (Claude Code, Windows box; Trevor** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#172) on 2026-11-24.
173. **RESOLVED 2026-10-09 ~1:39 PM PT (was OPEN 2026-10-04 ~6:45 PM PT) — closed** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#173) on 2026-11-24.
174. **DECIDED 2026-10-04 (~8:50 PM PT, Cowork cloud; Trevor** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#174) on 2026-11-24.
175. **RESOLVED 2026-10-10 ~8:56 AM PT (Cowork cloud, decided under Trevor's "make decisions on these…** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#175) on 2026-11-24.
176. **RESOLVED 2026-10-10 ~9:00 AM PT (Claude Code cloud)** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#176) on 2026-11-24.

177. **RESOLVED 2026-10-10 ~7:37 AM PT (Claude Code cloud)** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#177) on 2026-11-24.

178. **RESOLVED 2026-10-10 ~3:25 AM PT (Cowork cloud; decided under Trevor's "fix any issues you encou…** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#178) on 2026-11-24.

179. **RESOLVED (FIXED) 2026-10-10 ~3:15 AM PT (Cowork cloud; Trevor** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#179) on 2026-11-24.

180. **RESOLVED 2026-10-10 ~9:14 AM PT (Claude Code cloud)** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#180) on 2026-11-24.

181. **RESOLVED 2026-11-08 ~9:20 AM PT (Claude Code, Windows box)** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#181) on 2026-11-24.

182. **RESOLVED 2026-10-10 (~5:10 AM PT, Claude Code cloud, f4dd1891d** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#182) on 2026-11-24.

183. **RESOLVED 2026-10-10 ~7:50 AM PT (Claude Code cloud)** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#183) on 2026-11-24.

184. **RESOLVED 2026-10-10 ~6:10 AM PT (Claude Code cloud)** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#184) on 2026-11-24.


185. **RESOLVED 2026-10-14 ~5:21 PM PT (Claude Code cloud, 20261015001336) — closed** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#185) on 2026-11-24.

186. **CLOSED, NOT A DEFECT 2026-10-10 ~5:20 PM PT (Claude Code cloud)** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#186) on 2026-11-24.

187. **RESOLVED 2026-10-10 ~7:15 PM PT (Claude Code cloud, 20261011020600 + 20261011022500).** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#187) on 2026-11-24.

188. **RESOLVED 2026-10-10 ~10:00 PM PT (Claude Code cloud, 20261011050000).** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#188) on 2026-11-24.

189. **CLOSED BY DECISION 2026-10-23 ~2:50 PM PT (Cowork cloud, autonomous pass)** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#189) on 2026-11-24.

190. 🟡 **REOPENED 2026-11-14 ~3:40 PM PT (Cowork cloud) — the reason it closed is gone: Trevor bought Dune Analyst (4,000 credits/mo) and connected the Dune connector.** First use, same day: every pre-index Flowty loan default for tracked lenders was recovered and priced (ledger, `20261114221713`). **The gap re-measured:** 56 saved wallets hold 305,985 Top Shot moments; **201,255 have NO `moment_acquisitions` row and 24,812 more are gift/unknown with no price**. Dune `flow.cadence_events` can classify each from its last `TopShot.Deposit` tx (custodial pull = Withdraw from a Dapper delivery account; marketplace = `ListingCompleted`/`MomentPurchased` with price; loan default = `FundingSettled`; else transfer). **Blocker:** ~226k result rows cannot pass through a chat — they need the Dune→DB lane, and `workers/dune-proxy` only executes its 3 allowlisted queries (code default + `DUNE_ALLOWED_QUERY_IDS` var; R138 hardening's deploy state unverified; `workers-deploy.yml` needs the `CLOUDFLARE_API_TOKEN` repo secret, never set). Trevor step: set that secret (or add the query id to the worker var in the Cloudflare dashboard). Prototype query 9128647 (temp, 646 ids of 0xbd94…) — two API executions sat PENDING 30+ min with 0 credits charged while a `SELECT 1` on the small engine ran instantly. ⓘ Earlier state follows. — ✅ **CLOSED 2026-10-17, DECLINED by decision (Claude Code, Windows box; Trevor: "Make your own decisions"). No paid source is bought for pre-2023 Top Shot custodial pack opens.** Every free source is ruled out (below), and the three keyed options (Dune, Find Labs, Bitquery) are infra spend, which the roadmap holds at zero pre-revenue (CLAUDE.md). The gap affects 33 of 34 saved wallets' PRE-2023-11-08 history only; everything since is chain-sourced. **Reopen when** RPC has revenue, or a paying user asks for full-history pack P&L. ⓘ Original filing: 🟡 **OPEN 2026-10-11 ~7:10 AM PT (Claude Code cloud, session_01EnByTsX1Sqd9Z5MPssoQjW; Trevor: "all pack opening transactions for our tracked wallets … for all time") — Top Shot CUSTODIAL pack opens before 2023-11-08 are recorded for 1 of 34 saved wallets (0xbd94…, from its owner's CSV); the other 33 have NO free source.** Everything else reconciles (10-11): NFT pack opens match Dapper's `searchPackNft` for all 34 wallets and every collection (All Day 10,159 = 10,159, Golazos 266 = 266, Top Shot 26,944 = index + 354 boxes + rips awaiting the 12-hourly walk; estate-wide opened totals Pinnacle 91,471 and Golazos 78,830 equal the index), and custodial Top Shot opens 2023-11-08 → now come from the chain-arrival lanes (30,970 saved-wallet rips). **What is missing:** 69,028 Top Shot moments held at 2023-11-08 by 33 wallets have no arrival record (pack vs purchase unknown), and moments those wallets SOLD before then are not even seeded. Rigged alone is estimated at 900–3,600 missing packs. **Ruled out, with evidence (packs.md):** Flow access nodes below mainnet24 (gone); `sales` buyers before 2023 (581 of 166,522 in 2021 have a buyer); Dapper studio-platform (`searchTopShotNft` returns 0 rows even unfiltered); `public-api.nbatopshot.com` (530); `gs://flow-genesis-bootstrap` (state only; checkpoints BOUND pulls but cannot count them: 211/211 labelled pulls classed issuer-or-new, yet 40 % of buys too); Flipside (gone). **Keyed options (Trevor's decision):** Dune `flow.cadence_events` (purchase deferred 10-03; drafted query `docs/research/dune-rigged-custodial-opens-2026-09-29.sql`), Find Labs Simple API (`api.find.xyz`, 401 without a key, claims mainnet1 history, sold via QuickNode), Bitquery v1 (Flow frozen but possibly queryable; 401). Validate any of them first against 0xbd94…'s known 2021–23 reveals. **Related, also open:** arrivals 2023-11-08 → 2025-10-22 for NEWLY saved wallets wait on mainnet24–26 (#181; `run_chain_arrival_refloor` already handles anything that arrived after 2025-10-22). UFC Strike pack opens are recorded nowhere, and Dapper's UFC owner index is stale both ways (#186), so there is no trustworthy free source. ↳ **Probed ~7:50–8:30 PM PT 2026-11-14 (Claude Code cloud; Trevor: "keep probing … looking for new sources"): Dune `flow.cadence_events` holds the pre-2023 Top Shot purchases our `sales` lacks.** v1 `A.c1e4f4f4c4257510.Market.MomentPurchased` and `TopShotMarketV3` carry `{id, price, seller}`; the buyer is the same tx's `A.0b2a3299cc857e29.TopShot.Deposit.to`. Probe (Dune query 9129354, temp): 300 random no-acquisition-row held Top Shot moments of 0x75b51fecb785006f → **155 (52 %) were marketplace buys INTO that wallet, $8,716 (2021 $8,327)**, 145 arrived with no purchase in the deposit tx (most common sender `0xe1f2a091f7bb5245` = flowty_excluded_addresses "TopShot_Buyback_2"; ~5-deposit txs look like Dapper deliveries — unverified), 0 without a deposit. **Cost 80.5 credits (medium; small times out at 2 min; medium queued ~10 min + ran ~18 min) — the cost is the full-history Deposit scan, not the id count, so one `to IN (<56 saved wallets>)` query ≈ the same.** 857.8 / 4,000 credits used at ~8:30 PM PT (cycle resets 12-14). The account is at its private-saved-query cap (use temp queries). **Still blocked on the Dune→DB lane** for ~118k result rows (dune-proxy allowlist + `CLOUDFLARE_API_TOKEN`, Trevor), and Trevor wants to review before any estate-wide cost write. Rule if built: a buy counts only when the purchase tx deposits the moment TO this wallet. ↳ **DECISION ~8:45 PM PT 2026-11-14 (Claude Code cloud; Trevor: "do what you think is best for #1"): no lane built, no credits spent, nothing written — three facts make every build path wrong today.** (1) **Do NOT revive `sync-sales-ingest-dune` (query 8030177) for this:** 0 of 50 random 2021 Dune purchase `nft_id`s exist in `moments` (it holds 1.22M Top Shot moments, a small slice of all minted), and `apply_sales_ingest_external` skips ids not in `moments`, so a generic feed backfill pays ~13.6k credits for 2021 alone to land almost nothing. The target is cost basis for HELD saved-wallet moments, not `sales`. (2) **The query that does fit (`Deposit.to IN (<saved wallets>)` + same-tx purchase) would PUBLISH RPC's saved-wallet list:** every query on this team is public and the private-query cap is hit (Analyst's private allowance not stated in Dune docs). Unverified whether API-time parameters stay out of the public page, so no wallet list goes into a saved or temp query until Trevor picks: free a private slot, or accept the exposure. (3) **`dune_budget_state.paused = true` and `dune_budget_allocation` is still the free-plan split** — re-allocate for Analyst (4,000/mo, ~858 used, resets 12-14) before any lane draws on it. **Ready-to-build shape once those clear:** one medium-engine execution (~80 credits) over the saved wallets → `workers/dune-proxy` (add the id to `DUNE_ALLOWED_QUERY_IDS`; needs `CLOUDFLARE_API_TOKEN`) → a STAGING table, never `moment_acquisitions` directly, so Trevor reviews before any cost write. ↳ **BUILT ~9:05 PM PT 2026-11-14 (Trevor: "I have the analyst plan … do #1"):** private temp query **9129456** (a team query can be private when temp; the non-temp private cap is still full) lists saved wallets' still-held Top Shot moments whose last arrival was a `c1e4f4f4c4257510` marketplace `MomentPurchased` for that id in the same tx, before 2023-11-08. `/api/cron/stage-topshot-acquisitions-dune` pages its latest execution into **`topshot_dune_acquisition_stage`** (review-only). Budget table re-pointed at Analyst and unpaused. ⚠ The deployed dune-proxy must allow 9129456 (`DUNE_ALLOWED_QUERY_IDS` var, or a worker redeploy of the new default) before the stage fills. **Next, Trevor's call:** review the staged rows, then decide whether they go into `moment_acquisitions` and with what `source` label. ↳ **STAGED ~9:15 PM PT 2026-11-14 — awaiting Trevor's review.** dune-proxy now allows 9129456 (Cloudflare dashboard var `DUNE_ALLOWED_QUERY_IDS`, mirrored in `wrangler.toml`). Execution `01M7ES049T43WHA0JD7325ZSWW` (78.8 credits; ~177 credits this round incl. one failed run, 1,103 / 4,000 used): **49,054 buys across 53 wallets, all staged, run ok.** Against `moment_acquisitions`: **2,934 already-priced overlaps agree on price 2,934 / 2,934**. **37,485 still-held moments with NO acquisition row get a price ($1,279,080 total)**, and 1,789 existing rows with a NULL price would gain one. 6,846 staged moments are not in `wallet_moments_cache` today (cache staleness or moved since; do not import those blind). Still open: (a) Trevor's go/no-go and the `source` label for the import, (b) the ~half of the gap that arrived with NO purchase in the deposit tx (pack pulls / transfers), which this query deliberately leaves out. ↳ **IMPORTED ~9:20 PM PT 2026-11-14 (Trevor 9:16 PM: "yes keep going") — `20261115051836`:** 37,485 new `moment_acquisitions` rows + 1,789 formerly-NULL-price `cache_refresh` rows priced = **39,274 rows, $1,294,739**, source `dune_marketplace_backfill_20261114`, `marketplace` / `verified`; prior values of the 1,789 archived in `flowty_archive.audit_20261114_190_unpriced_rows`; 0 duplicate keys. Live in `get_acquisition_stats` / cost-basis reads at once (no cache). Revert in the migration header. **Remaining gap:** held moments whose arrival tx has NO purchase (custodial pack deliveries, transfers) — next classification step. ↳ **STEP 2 LOADED ~10:05 PM PT 2026-11-14:** wallet-scoped provenance (query 9129489, exec `01M7ETHE1Z3QNZWENDQTY6D1MQ`) — 494,427 rows in `topshot_arrival_provenance`; controls 99.7–100 % agreement. Dry run of `apply_topshot_arrival_provenance()`: 45,186 pack pulls ($0) + 8,803 offers ($88,694) + 5,239 marketplace ($35,348) + 55 storefront ($371). Not applied — Trevor's call. ⚠ Lesson: Dune strips leading zeros from Flow addresses; 9129456 missed the three `0x0…` saved wallets (53/56). 9129489 matches both forms. ↳ **STEP 2 APPLIED ~10:10 PM PT 2026-11-14 (Trevor: "Apply all"):** 59,283 rows (52,328 inserts + 6,955 unknown→known; 45,186 pulls at $0, $124,413.60 of buys). Gap now **27,934 no-row + 3,280 unpriced** of 306,004 held. **Next:** the 24,832 `T` transfers — follow each one hop back (the sender's own acquisition, often the same collector's other wallet) before any price is assumed. ↳ **STEP 3 STALLED ON BUDGET ~7:30 AM PT 2026-11-15:** hop table reshaped (`20261115145948`). Hop v2 returned 1.88M rows (not loaded); v3 returned the right 102,800 but cost **1,647 credits** (inequality join on JSON fields over unpruned `cadence_events`) — cycle at 3,991 / 4,000, Dune reads paused (`20261115153135`). ⛔ **Lesson: never run a Dune join keyed on `json_extract_scalar(...)` with a `<` and no `block_date` bound before sizing it on a small slice; a correct row count can still be a 14× cost.** Next: after the Dec 13 reset (or bought credits) unpause, trigger `?lane=hop` by hand once (~200 credits; execution `01M7FVKJ3ECV58KPMVTV7H3T77`, if Dune still holds its result), then the review breakdown for Trevor. ↳ **STATE AT THREAD ARCHIVE ~7:40 AM PT 2026-11-15:** imported so far 39,274 marketplace + 59,283 provenance rows. Left, of 306,004 held: 27,934 no-row + 3,280 unpriced — 24,832 plain transfers (hop data computed, not loaded), 1,308 `N` (deposit with no withdraw), 685 `S` (self re-deposit), 130 `X` (non-USD storefront). Purchases/provenance loader crons removed (loads complete); hop resumes via the standalone scheduled task **`trig_01UUaB7qr9Kz4zfDLUxVtwEP`** (Dec 13 5 PM PT). Review tables kept: `topshot_dune_acquisition_stage` (49,054), `topshot_arrival_provenance` (incl. 494,427 wallet-scoped rows), `topshot_transfer_hop_stage` (empty). Dune lessons: apis-and-cadence.md (end). N/S/X need their own Dune pass after the reset (S = look one more arrival back; N = likely mints/airdrops — check the tx's other events).

191. **RESOLVED 2026-10-14 ~6:30 PM PT (watch CLOSED 2026-10-17 ~6:49 PM PT** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#191) on 2026-11-24.

192. **RESOLVED 2026-10-17 (Claude Code cloud, docs-refresh pass; found by the All Day roadmap researc…** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#192) on 2026-11-24.

193. **RESOLVED 2026-10-30 ~5:20 PM PT (Claude Code cloud, scheduled weekly read; read-only) — closed** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#193) on 2026-11-24.

194. **RESOLVED 2026-10-18 ~10:15 AM PT — closed** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#194) on 2026-11-24.

195. **RESOLVED 2026-10-18 ~3:24 PM PT (Claude Code cloud, 20261018222342) — closed** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#195) on 2026-11-24.

196. **RESOLVED 2026-10-18 ~5:15 PM PT, verified on production ~5:38 PM PT and gated (Claude Code clou…** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#196) on 2026-11-24.
197. **RESOLVED 2026-10-20 ~7:40 AM PT (Cowork cloud, 20261020142417, UPDATE-only)** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#197) on 2026-11-24.

198. **RESOLVED 2026-10-27 ~7:40 PM PT (Cowork cloud) — closed** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#198) on 2026-11-24.

199. **RESOLVED 2026-10-20 ~10:45 PM PT (Cowork cloud, 20261021054000, dashboard SQL editor, Trevor ap…** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#199) on 2026-11-24.

200. **RESOLVED 2026-10-20 ~10:47 PM PT (Cowork cloud, 20261021055500, dashboard SQL editor, Trevor ap…** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#200) on 2026-11-24.

201. **RESOLVED 2026-10-20 ~10:35 PM PT (Claude Code cloud, 20261021053313 + docs/audits/2026-10-20-pa…** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#201) on 2026-11-24.

202. **RESOLVED 2026-10-26 ~8:10 PM PT (Cowork cloud; Trevor 8:02 PM "make decisions … take care of al…** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#202) on 2026-11-24.

203. **CLOSED BY DECISION 2026-10-21 ~12:05 AM PT (Cowork cloud, under the standing "make product deci…** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#203) on 2026-11-24.

204. **RESOLVED 2026-10-21 ~6:07 PM PT (Trevor** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#204) on 2026-11-24.

205. **RESOLVED 2026-10-21 ~12:50 PM PT (Claude Code cloud; Trevor chose option (b), "make it a real s…** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#205) on 2026-11-24.

206. **CLOSED BY DECISION 2026-10-21 ~11:40 PM PT (Trevor** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#206) on 2026-11-24.

207. **RESOLVED 2026-10-21 — market Player search is accent-blind for an empty search, in the route (n…** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#207) on 2026-11-24.

208. **RESOLVED 2026-11-13 ~8:05 PM PT (Claude Code cloud; Trevor** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#208) on 2026-11-24.

209. **CLOSED 2026-11-23 ~11:43 AM PT (Claude Code cloud; Trevor** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#209) on 2026-11-24.

210. **CLOSED 2026-11-23 ~11:43 AM PT (Claude Code cloud; Trevor** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#210) on 2026-11-24.

211. **RESOLVED 2026-10-25 ~6:35 PM PT (Cowork cloud, 20261026013559 part B2, dashboard SQL editor wit…** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#211) on 2026-11-24.

212. **RESOLVED 2026-10-26 ~8:45 PM PT — closed** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#212) on 2026-11-24.

213. **CLOSED 2026-11-05 ~1:39 PM PT (Claude Code cloud; decided under Trevor's delegation — closed** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#213) on 2026-11-24.
214. **RESOLVED 2026-10-26 ~9:10 PM PT — closed** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#214) on 2026-11-24.
215. **RESOLVED 2026-10-30 ~8:40 PM PT (Claude Code cloud) — closed** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#215) on 2026-11-24.
216. **RESOLVED 2026-10-29, migrations applied 10:18–10:25 AM PT (Claude Code cloud; 20261029171852, 2…** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#216) on 2026-11-24.
217. **RESOLVED 2026-10-31 ~4:27 AM PT (Cowork cloud, autonomous pass) — closed** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#217) on 2026-11-24.
218. **CLOSED 2026-11-23 ~11:41 AM PT (Claude Code cloud; Trevor** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#218) on 2026-11-24.

219. **RESOLVED — and RE-CLOSED on the writer that actually runs, 2026-10-31 ~12:20 PM PT (Cowork clou…** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#219) on 2026-11-24.

220. **RESOLVED 2026-10-31 ~2:05 PM PT (Cowork cloud; Trevor** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#220) on 2026-11-24.

221. **CLOSED 2026-11-08 ~11:30 AM PT (Claude Code, Windows box)** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#221) on 2026-11-24.

222. **RESOLVED 2026-11-01 ~8:45 AM PT (Claude Code cloud; Trevor** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#222) on 2026-11-24.

223. **RESOLVED 2026-11-02 ~8:38 AM PT (Cowork cloud, Chrome; Trevor** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#223) on 2026-11-24.

224. **RESOLVED 2026-11-01 ~10:00 AM PT (Claude Code cloud; Trevor** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#224) on 2026-11-24.

225. **CLOSED BY DECISION 2026-11-02 ~8:48 AM PT (Cowork cloud; Trevor** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#225) on 2026-11-24.

226. **CLOSED 2026-11-05 ~11:50 AM PT (Claude Code cloud, autonomous daytime pass; read-only) — closed** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#226) on 2026-11-24.

227. **RESOLVED 2026-11-04 ~7:10 AM PT (Cowork cloud) — closed** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#227) on 2026-11-24.

228. **CLOSED — ACCEPTED RESIDUAL 2026-11-23 ~11:42 AM PT (Claude Code cloud; Trevor: "try to resolve…** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#228) on 2026-11-24.

229. **CLOSED 2026-11-23 ~11:42 AM PT (Claude Code cloud; Trevor** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#229) on 2026-11-24.
230. **RESOLVED 2026-11-04 ~10:45 AM PT (Cowork cloud; Trevor** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#230) on 2026-11-24.

231. **RESOLVED 2026-11-04 ~11:02 AM PT — closed** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#231) on 2026-11-24.

232. **RESOLVED 2026-11-04 ~5:45 PM PT (Cowork cloud, Trevor's Chrome) — closed** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#232) on 2026-11-24.

233. **RESOLVED 2026-11-04 ~8:10 PM PT (Cowork cloud; Trevor** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#233) on 2026-11-24.

234. 🟡 **OPEN — RELABEL COMPUTED, DEFERRED TO AFTER THE GATE — 2026-11-23 ~11:40 AM PT (Claude Code cloud; Trevor: "try to resolve these still open").** Both weeks are in (11-09, 11-16; `fmv_accuracy_weekly` Top Shot, segment = confidence × last-sale age × 90-d depth, the 11-13 rule: n ≥ 200 in BOTH weeks and the same band). Exactly ONE segment earns a different label: **MEDIUM · last sale ≤ 7 d · 3+/90d → HIGH** (75.0 % n 8,675 / 75.2 % n 11,693). Every other ≥ 200 segment already carries its band (HIGH ≤7d 80.3/83.8; HIGH 8–30d 78.2/74.2; LOW ≤7d 3+ 55.0/53.3) or the weeks disagree (MEDIUM 8–30d 71.2 → 62.9; LOW 8–30d 63.7 → 58.6; LOW 31–90d 62.6 → 54.9). **Why it is NOT applied now:** the go-live gate is "HIGH and MEDIUM each ≥ 70 for 4 consecutive weeks". Moving that segment out of MEDIUM re-scores 11-16's MEDIUM from **73.1 → 62.6** (11-09: 74.1 → 71.0), so it would retroactively fail week 2 and restart the clock for a change in the label definition, not in any price. Labels are internal (Concierge rule 3: no tier shown), so deferring costs users nothing, and changing a classifier mid-streak makes weeks 3–4 measure a different MEDIUM (the pooled-across-a-change trap). **Decision:** score the gate on the current definition through the 11-30 week (read Mon 12-07). Then apply this relabel (one segment, label only, never the price) and re-baseline every later read. ⭐ **Finding it surfaced, already true today:** MEDIUM's ~73 % is carried by editions with a sale in the last 7 d; MEDIUM with the last sale 8–30 d ago (n ≈ 2,300/week) read 62.9 % on 11-16. Watch that cell in the 11-23 and 11-30 weeks. If MEDIUM fails the gate, that is the segment, and the lever is its price (last-sale age), not its label. ⓘ Previous status follows. — 234. 🟡 **OPEN — READ 2026-11-16 ~9:20 PM PT (Claude Code cloud, autonomous pass): the first post-11-04 week (11-09) is in, and its ASK_ONLY cell is an INSTRUMENT ARTIFACT that must not drive a relabel.** `fmv_accuracy_weekly` Top Shot, within ±25 %, wk 10-26 → 11-02 → **11-09**: ALL 68.2 → 69.3 → **70.3** · HIGH 74.3 → 75.5 → **80.1** · MEDIUM 69.1 → 69.7 → **74.1** · LOW 54.9 → 57.3 → **57.0** · ASK_ONLY 48.6 → 49.9 → **18.4 (n 1,269)**. All Day 11-09: ALL 62.8 · HIGH 76.8 · MEDIUM 64.8 · LOW 47.8 · ASK_ONLY 37.8. **The ASK_ONLY collapse is the 11-11 drop of sets 281/282:** re-derived from `sales_market` for the same week, ASK_ONLY sales on editions whose first sale predates 11-01 read **60.9 % (n 302, median ratio 1.00 — the 11-04 thin-tail fixes worked)**, while editions first sold after 11-01 read **5.1 % (n 967, ratio 2.40)**. Those 967 are launch sales measured against the launch-hour ask price, because the instrument takes the snapshot ≥ 1 day BEFORE the sale — e.g. 281:9342 published $29.70 ASK_ONLY 11-11 1:09 PM, $13 HIGH by 11-12 8:48 AM; its 11-12/13 sales are scored against the $29.70 that was no longer shown. **So the relabel must score ASK_ONLY on established editions only (first sale older than the 1-day embargo + the week), or the 11-09 cell reads a tier it did not earn.** Second trap for anyone measuring sale → reprice lag: `writeTodaySnapshots` purges an edition's EARLIER same-day rows, so `fmv_snapshots` keeps only the last write per edition per day and cannot show a morning hot-lane reprice (afbe2297 read as a 22.5 h lag that the purge may have hidden). At 9:40 PM PT the hot lane's only pending editions were 3 whose sole sales are serial ≤ 10 (correctly unpriced); it runs 5–20 editions per tick against a 150 cap. ⓘ Earlier text follows. — 🟡 **OPEN — 2026-11-13 ~8:20 PM PT (Claude Code cloud; Trevor: "make these decisions yourself") — DECIDED how the relabel works; exit (2) is already DONE.** All Day's accuracy job exists (`rpc-fmv-accuracy-weekly-allday`, jobid 829, Mon 11:45Z) and has written the 10-26 and 11-02 weeks. **The relabel rule:** a segment (confidence × last-sale age × 90-d depth) takes the label its MEASURED within-±25 share earns — HIGH ≥ 70 %, MEDIUM 60–70 %, LOW 50–60 %, below 50 % the lowest tier — only with n ≥ 200 in the segment, and only once TWO post-11-04 weeks agree on the band (11-09 and 11-16 weeks; the earliest relabel is after the Mon 11-23 run, not 11-16). The relabel moves only the label, never the price, and stays internal (Concierge rule 3: no tier is shown anywhere; the API field keeps its name). ⓘ Earlier text follows. — 🟡 **OPEN — NEW 2026-11-04 ~10:45 PM PT (Claude Code cloud; Trevor 6:16 PM: "We need to get confidence on pricing. That's the anchor of everything we do.") — FMV confidence labels are a 30-day SALES COUNT, not a measured accuracy, and the two disagree both ways.** HIGH ≥ 7 sales / MEDIUM ≥ 5 in 30 d says nothing about how close the price lands. Measured 11-04 on clean Top Shot sales since 10-23 (`sales_market`, serial > 25, the snapshot in force ≥ 1 d before): MEDIUM whose last sale is 31–90 d old read **~53 %** within ±25 % (over-claims), while ASK_ONLY capped at a recent sale with 3+ sales in 90 d read **~62–69 %** (MEDIUM-grade, labelled the lowest tier). ⭐ **The instrument now exists:** `fmv_accuracy_weekly` (`20261105040000`) — per collection × PT week × confidence × last-sale age × 90-d depth × price band: n, within ±25, median ratio, WAPE; `refresh_fmv_accuracy_weekly(collection, monday)`, pg_cron `rpc-fmv-accuracy-weekly` (jobid 828, Mon 3:37 AM PT, **Top Shot only**). Baseline week 10-26 (PRE-11-04 prices): HIGH 74.3 · MEDIUM 69.1 · LOW 54.9 · ASK_ONLY 48.6 (n 11,041). **What changed the prices the same evening** (all applied unless marked): ask-only capped at the last sale (`20261105024000`), every Top Shot price floored at the best open edition offer ≤ 3× (`20261105033000`), the thin-sale haircut stops at that bid (`20261105044500`), All Day LOW unknown-depth haircut 0.55 → 0.75 (`20261105050000`, applied by Cowork ~10:27 PM PT), basis_capped survives `_bidfloor` (`20261105063000`, applied 2026-11-05 ~1:25 PM PT, recorded as `20261105212546`). **Measured and NOT shipped (do not re-try without new data):** Top Shot MEDIUM/HIGH from last-3/5/10 or 7-day medians (≤ +1.5 pts — the published price sits at the ~72 % ceiling a sale-history estimator reaches); an ordinary low-serial (26–250) premium (bias 0.90 → 0.95 but within ±25 59.5 → 59.4); LOW from the last-3 median (58.1 → 60.0); All Day ASK_ONLY last-sale cap / lower ask multiplier (halves disagree); raw bids as an estimator (≈ 0.6–0.67 of listing purchases — a floor, not a price); age-adjusted comps (worse out of sample). **EXIT:** (1) once the **11-09 week** has filled (first run Mon 11-16 3:37 AM PT), relabel by measured segment accuracy — the label's promise must match its segment's within ±25 — never calibrate on pre-11-04 weeks; (2) add an All Day job (`refresh_fmv_accuracy_weekly('dee28451-…', …)`) beside the Top Shot one; (3) labels stay INTERNAL (rule 3, 10-18) — this changes which prices gates trust, not what users see. Handoffs: `docs/handoff-2026-11-04-*` (fmv-confidence-three-migrations, fmv-haircut-stops-at-bid, allday-low-haircut-075, edition-detail-capped-bidfloor). **11-05 ~11:45 AM PT (Claude Code cloud): EXIT (2) DONE — `20261105194500_audit_20261105_fmv_accuracy_weekly_allday`, applied ~1:26 PM PT with Trevor's approval (recorded `20261105212641`, pg_cron jobid 829; All Day 10-26 baseline 1,841 sales, 62.1 % within ±25 %: HIGH 72.5 · MEDIUM 66.3 · LOW 43.9 · ASK_ONLY 42.4)** schedules `rpc-fmv-accuracy-weekly-allday` (Mon 11:45 UTC = 3:45 AM PST, 8 min after 828; minute 45 of hour 11 otherwise empty) and seeds the 10-26 week as a pre-change baseline. `refresh_fmv_accuracy_weekly` is collection-generic (read live), so no function change. Parse-checked. `20261105063000` (`basis_capped` survives `_bidfloor`) applied the same minute (recorded `20261105212546`; live body md5 = the file's `8fc970d1…`; `/nba-top-shot/edition/169:6317` now reads "capped at sales").
235. **CLOSED 2026-11-23 ~11:35 AM PT (Claude Code cloud; Trevor** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#235) on 2026-11-24.
236. **RESOLVED 2026-11-06 ~7:20 PM PT (Cowork cloud; Trevor from his phone mid-Dame-Time entry** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#236) on 2026-11-24.
237. **CLOSED 2026-11-08 ~8:35 AM PT (Claude Code, Windows box)** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#237) on 2026-11-24.

238. **CLOSED 2026-11-08 ~8:25 AM PT (Claude Code, Windows box)** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#238) on 2026-11-24.

239. **RESOLVED 2026-11-07 ~11:27 PM PT — closed** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#239) on 2026-11-24.

240. **CLOSED 2026-11-08 ~12:05 PM PT (Cowork cloud; Trevor 12:00 PM** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#240) on 2026-11-24.

241. **RESOLVED 2026-11-13 ~7:25 PM PT (Claude Code cloud; Trevor** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#241) on 2026-11-24.

242. **RESOLVED 2026-11-10 ~7:10 PM PT (Claude Code cloud) — closed** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#242) on 2026-11-24.

243. **RESOLVED 2026-11-10 ~2:12 PM PT (Claude Code cloud) — closed** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#243) on 2026-11-24.

244. **RESOLVED 2026-11-09 ~7:35 PM PT (Claude Code, Trevor’s laptop) — closed** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#244) on 2026-11-24.

245. **RESOLVED 2026-11-10 ~2:25 PM PT (Claude Code cloud) — closed** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#245) on 2026-11-24.
246. **RESOLVED 2026-11-12 ~10:05 PM PT (Claude Code cloud) — closed** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#246) on 2026-11-24.
247. **RESOLVED 2026-11-13 ~7:10 PM PT (Cowork cloud; Trevor** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#247) on 2026-11-24.
248. **RESOLVED 2026-11-16 ~10:30 AM PT (Claude Code cloud, scheduled close-out trig_01CScx2oshq9AXFGx…** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#248) on 2026-11-24.
249. **CLOSED 2026-11-23 ~11:34 AM PT (Claude Code cloud; Trevor** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#249) on 2026-11-24.
250. **RESOLVED 2026-11-14 ~6:10 PM PT (Claude Code cloud; Trevor** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#250) on 2026-11-24.
251. **CLOSED 2026-11-14 ~5:20 PM PT (Claude Code cloud; Trevor** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#251) on 2026-11-24.
252. **CLOSED 2026-11-14 ~8:05 PM PT (Claude Code cloud) — closed** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#252) on 2026-11-24.
253. **CLOSED 2026-11-18 ~5:35 PM PT (Claude Code cloud, autonomous pass) — closed** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#253) on 2026-11-24.
254. **CLOSED (decided + shipped) 2026-11-14 ~8:15 PM PT (Claude Code cloud; Trevor** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#254) on 2026-11-24.
255. **CLOSED — 2026-11-15 ~10:35 AM PT (Cowork, SQL editor: parked copy dropped as 20261115183513). ⓘ…** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#255) on 2026-11-24.
256. **RESOLVED 2026-11-22 ~12:40 PM PT (Claude Code cloud; Trevor** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#256) on 2026-11-24.
257. **RESOLVED 2026-11-21 ~7:09 PM PT (Claude Code cloud) — closed** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#257) on 2026-11-24.
258. **CLOSED 2026-11-23 ~11:48 AM PT (Claude Code cloud; Trevor** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#258) on 2026-11-24.
259. **RESOLVED 2026-11-17 ~4:07 PM PT (Claude Code, laptop) — closed** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#259) on 2026-11-24.
260. **RESOLVED 2026-11-17 ~6:41 AM PT (Claude Code cloud; Trevor** — ✅ CLOSED; full text moved verbatim to [known-issues-archive.md](known-issues-archive.md) (#260) on 2026-11-24.
261. 🟡 **OPEN — NARROWED 2026-11-23 ~11:52 AM PT (Claude Code cloud; Trevor: "Keep working through all you can"): the undated PACK PULLS did not need Dune — 12,976 dated from our own tables (`20261123195151`).** `pack_open_pulls.pack_nft_id` → `pack_rips.sealed_at` is the open-event block time: it equals the independent `allday_pack_pull.sealed_at` on all 1,487,682 packs present in both (median |diff| 0 s). `pack_pull_open_time()` now falls back to it for Top Shot and All Day (only when the existing source has nothing, the pack's opener = the wallet exactly, and there is exactly one open time). The insert trigger therefore dates future pulls of this shape too. `backfill_pack_pull_dates()` dated **Top Shot 1,746 + All Day 11,230**, 0 later than their row's creation, each archived in `flowty_archive.acq_pack_pull_date_20261117` (`written_at` ≥ 19:50Z 11-23). Undated pack pulls: 13,001 → **25** (several rips / another opener, correctly left). **Still needs chain history (Dune reset Dec 13 4 PM PT):** held moments with NO acquisition row (Pinnacle ~7.6k, All Day ~9.4k, UFC 609, Golazos 157) and Top Shot kind S re-deposits. ⓘ Previous status follows. — 261. 🟡 **OPEN (data, blocked on Dune credits until Dec 13 4 PM PT = 12-14 00:00 UTC) — 2026-11-16 ~8:40 PM PT (Claude Code cloud; Trevor, from a phone binder: "how can we get acquisition date filled in?") — held moments whose acquisition DATE we cannot prove from our own tables.** What the binder shows as Acquired is `COALESCE(moment_acquisitions.acquired_date, wmc.acquired_at)` (newest `created_at` row) — ⚠ `wmc.acquired_at` alone (NULL on 13,220 of one founder wallet's 15,793) is NOT the instrument. **Closed 11-16 (all archived, revert in each migration header):** a new moment's sale/pull is proven at first sight by `fill_acquisitions_for_moments` before any `unknown` placeholder (`20261117043000`; verified live 8:05 PM PT on a real view, 2/2 proven); Top Shot kind-T arrivals 23,608 (`20261117044500`, applied by Cowork), kinds N/X 1,406 (`20261117170000`); **31,230 proven `pack_pull` rows had been written with NULL `acquired_date`** by every fact-only pull writer — a BEFORE INSERT trigger (`trg_moment_acq_pack_pull_date`, `20261117171500`/`20261117173000`) now dates any pull at insert where an open time exists, and 19,875 existing were dated (TS 13,151 · All Day 5,567 via `allday_pack_pull.sealed_at` = open-event block time · Golazos 884 · Pinnacle 273). **Still unproven (dated sample 11-16 ~8:30 PM PT):** ~11.4k pack pulls undated (All Day proven only via `pack_open_pulls`, which has no time column; TS 110 with no Dune P row); saved-wallet held moments with NO row — Pinnacle 7,595 (5,614 one wallet; pins predate the `pinnacle_mint_events` floor 2025-10-22), All Day ~9.4k, UFC 609, Golazos 157 (opened by ~30 OTHER wallets in 2022–23 — correctly NOT claimed as the holder's pulls); TS kind S 684 (a same-wallet re-deposit is not an acquisition). **All need chain history; Dune is at 4,000/4,000 credits until the reset at Dec 13 4 PM PT (no spend pre-revenue).** Method + contracts: inbox `2026-11-17T0440Z-claude-code-acquisition-dates-remaining-needs-dune.md`. **Display rules shipped with it** (`formatAcquiredAt`): a midnight-UTC value is a calendar DATE (formatted in UTC — 1,329 of one wallet's first 2,000 rows read a day early in PT); `acquisition_method = 'unknown'` reads "by <date>" (an upper bound or a bare arrival — never a claimed method). **Exit:** after the reset (Dec 13 4 PM PT), run the per-collection arrival query on one wallet first (read `executionCostCredits`), then write date-only rows the shape of `apply_topshot_arrival_dates()`. ↳ **CHECKED 2026-11-24 ~9:12 PM PT (Claude Code, attended) — no own-table win left for SAVED wallets:** Pinnacle held pins with no acquisition row whose LATEST `pinnacle_sales` buyer is the holder (the exact arm-A rule of `fill_acquisitions_for_moments`) = **1,777 ($32,912, 17 wallets) — all 17 NOT in `saved_wallets`; saved wallets 0.** Job 886 (`refresh_saved_wallet_acquisitions`, every 2 h) covers saved wallets only, by design: 213 pairs, 0 errors, all re-run within 4 h. Widening it to every looked-up wallet is a scope/load call, not a defect (non-saved no-row counts are large: Top Shot 1.61M, All Day 472k).



### Displaced from CLAUDE.md 2026-08-23 (verbatim) — the sports-proxy 403 bullet

Moved here to pay for two new standing rules; nothing deleted. The one-line pointer in CLAUDE.md now
carries only the verdict.

> - **The sports-proxy `403` — NOT a secret, and ⛔ "PROXY ESPN" IS MEASURED DEAD.** ⚠ **"ESPN: 200 residential ⇒ proxy it" was a DATED SAMPLE and it EXPIRED — re-measured 08-22, ESPN 403s residentially too**, so a CF Worker is just another egress. ⛔ UA-refresh and 403-retry stay useless. ⚠ Restoring ESPN alone still would NOT refill `nba_players` (SLATE-GATED). ⚠ **The "no alert" gap is a MYTH** — the failure-rate arm reads 100%, deliberately SUPPRESSED to 2026-10-14.

    ⭐ **THE ALLDAY HALF IS FULLY DIAGNOSED, and the asymmetry is exact — read from `cron.job` by SUBSTRING TEST, never by printing the command (these carry live gate keys).** `allday-pack-opens-backfill` is the edge function `ingest-allday-pack-opens`, so its caller must be pg_cron/pg_net. There are exactly two pack-opens jobs:

    | jobid | jobname | schedule | calls the AllDay fn | mentions `backfill` | active |
    |---|---|---|---|---|---|
    | 20 | `rpc-allday-pack-opens-forward` | `9,39 * * * *` | **yes** | **no** (mode=forward) | true |
    | 56 | `rpc-topshot-pack-opens-history` | `11,26,41,56 * * * *` | no | **yes** | true |

    ⛔ **So the AllDay side is scheduled FORWARD-ONLY, while its Top Shot twin has BOTH.** There is no AllDay pack-opens backfill job anywhere — which is why the lane's death on 09-04 left no trace: **nothing in this database was ever calling it.**

    ⛔ **NOT RESCHEDULED, and the reason is not timidity.** A pg_cron schedule IS a lever available without a push, but this one would **resume a data-writing backfill that stopped for a reason nobody has established** — and its sibling lane was deliberately unscheduled on 09-08 for a good one (#101). ⭐ **The decision is now a one-minute one for an operator:** either add the missing backfill job in the shape of jobid 56, or accept the coverage gap and **rewrite the suppression, which currently calls a stop at 83,276,329 “terminal” when the floor is 65,264,619.**

