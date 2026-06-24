# Handoff — 2026-06-23 media recovery + repo-sync (Claude Code)

**Context.** Continuation of the 2026-06-23 audit work. Cowork shipped two more migrations **live** this session (legacy TS thumbnail + video recovery from the on-chain IPFS catalog) on top of the three already repo-synced earlier (`allday_scarcity_board_view`, `pinnacle_ask_only_cover_null_confidence`, `revoke_dormant_anon_dml_defense_in_depth`). This handoff is the **repo-sync of the two new migrations** plus the **worker path for the irreducible media tail**. No route/.tsx change is required for the recovery itself — it's source-data, and the tile components already read `thumbnail_url`/`video_url`. Platform health green throughout: security `0/0/0/0`, trust 9/9, `detect_stalled`/`alerts`/`secdef_anon` all `[]`.

**Claude Code's direct file inspection wins over this doc on any disagreement — adapt to the actual file shape.**

## Shipped live by Cowork this session (repo-sync these two)

- **`audit_20260623_recover_ts_base_thumbnails_from_ipfs`** — repointed **7,517** broken legacy TS base-edition `thumbnail_url`s from the dead `assets.nbatopshot.com/editions/<set>/<uuid>` path (404s) to the canonical `https://ipfs.dapperlabs.com/ipfs/<hero_cid>` form, sourced from `topshot_ipfs_assets` (`parallel='Base'`, latest by `loaded_at`). All targets are base editions (0 parallels in the broken set → no subID/parallel-mismatch risk); player+set names verified to match the catalog; the URL format is identical to the already-working 185 IPFS thumbnails (host CSP-whitelisted by `7fe106d3`). Aligned with the ledger's "IPFS is canonical" stance (this is the dead-CDN→IPFS direction, **not** the declined IPFS→CDN migration). Backup table `public.audit_20260623_ts_thumb_ipfs_backfill` (RLS on, anon/auth revoked) holds old+new per edition for exact revert.
- **`audit_20260623_recover_ts_base_videos_from_ipfs`** — companion: repointed **7,499** broken base-edition `video_url`s (hover-play) to `https://ipfs.dapperlabs.com/ipfs/<video_cid>`. Proven mapping: a clean base edition's working IPFS `video_url` CID exactly equals the `Base` `video_cid` (verified on a 5-edition sample; not the square/tall/vertical variants). Backup table `public.audit_20260623_ts_video_ipfs_backfill`.

**Repo-sync action:** add faithful parity copies under `supabase/migrations/` (the dir is live-only since 2026-05-17 — copies are a parity record, not a re-apply). Record both in `docs/overnight/ledger.md` with the revert paths below so the nightly pass doesn't re-touch the affected editions.

**Revert (either):** `UPDATE public.editions e SET thumbnail_url = b.old_thumbnail_url FROM public.audit_20260623_ts_thumb_ipfs_backfill b WHERE e.id = b.edition_id;` (and the analogous `..._ts_video_ipfs_backfill` for video). The old values were the 404ing `editions/` URLs, so reverting only re-breaks them — not advisable.

## 1. Irreducible media tail — WNBA + Base-Set catalog gap (worker)

**Status (measured).** After the recovery, **1,541 thumbnails / 1,559 videos** remain on the dead `editions/` path. **0 of them have any row in `topshot_ipfs_assets`** (not a parallel mismatch — they're simply absent from the catalog). They're dominated by **WNBA sets** (WNBA 2023/2024/2025, WNBA Base Set, WNBA: Best of 2021) plus some **Base Set** residue; series 1–8, only 6 are `set_id_onchain ≤ 10`.

**Root cause.** The on-chain IPFS catalog (`topshot_ipfs_assets`, 12,571 rows, built by the `TopShotIPFSResolver.getCIDs` backfill — the daily `backfill-topshot-onchain-art` path) hasn't ingested these plays, so there's no CID to point at. The daily art cron also likely skips them because their `thumbnail_url` is non-null (a dead URL), not NULL — confirm its selection predicate.

**Fix (worker / route — not Cowork-shippable).**
1. Extend/run the TopShot IPFS catalog backfill (`app/api/admin/backfill-topshot-onchain-art` + whatever populates `topshot_ipfs_assets`) to cover the missing WNBA + residual Base-Set plays — confirm `TopShotIPFSResolver.getCIDs(set, play)` returns CIDs for them (some very old/WNBA plays may genuinely have no on-chain IPFS art).
2. Once `topshot_ipfs_assets` has them, **re-run the two recovery migrations** — they're idempotent (`ON CONFLICT DO NOTHING`, only touch `editions/`-pattern rows) and will pick up the newly-cataloged plays.
3. Consider making the daily art cron re-fill dead-but-non-null `editions/`-path thumbnails (not just NULL ones) so this self-heals going forward.

**Verify:** `SELECT count(*) FROM editions WHERE collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd' AND thumbnail_url LIKE '%assets.nbatopshot.com/editions/%'` trends below 1,541.

## 2. Already decided this thread (do NOT re-litigate)

- **Edition-page latency** — shipped (`d9721d0`, streaming split). Done.
- **AllDay ASK_ONLY $10k cap** — declined (the high tail is 5 genuinely-scarce editions incl. a Mahomes /10 Ultimate with a corroborating $2,399 sale; tightening risks suppressing real grails). Pricing-judgment, leave unless Trevor directs.
- **Pack opened/unopened counts** — data-gated (supply only exists for ~60 currently-listed packs via `getPackListing.packListingContentRemaining`; panel already hides gracefully). No fixable bug.
- **AllDay parallels / Pinnacle variants** — fully documented in `docs/reference/parallels-variants-data-model.md`; both are de-conflated by their native model (no work needed). Reference only.

## 3. Cross-collection follow-on findings (this session)

- **AllDay hover-play video is BROKEN site-wide (CONFIRMED 2026-06-24; needs frontend discovery).** `editions.video_url` for 6,176/6,191 AllDay editions is the dead `assets.nflallday.com/editions/<set>/<uuid>/...Video...mp4` (live test → S3 404). The main grids/edition pages render `video_url` directly, so AllDay hover-play is dead everywhere. **`lib/media/momentVideoUrl.ts`'s AllDay form is ALSO stale** — `media.nflallday.com/editions/<id>/media/video?width=512&format=mp4` (its "verified 2026-05" pattern) now returns *"ERROR 9401: 'mp4' is not a supported output format"* — that `media` endpoint is an image resizer (jpeg/webp/avif/json only). So even the **Trophy modal's** AllDay video (the only consumer of the helper) is broken. **A Cowork data-recovery was attempted to that helper form and reverted** (`audit_20260624_recover_allday_video_url_to_media_cdn` → `audit_20260624_revert_allday_video_recovery_stale_form`; net no-op) once the form proved stale. **What's needed (CC/browser):** discover the *current* AllDay video CDN URL by inspecting a live `nflallday.com` moment page's `<video>` src (the site is Cloudflare-WAF-blocked from server/sandbox IPs, so this needs a real browser session), then (a) fix `momentVideoUrl.ts` and (b) repoint `editions.video_url` via the same backup-table pattern. Thumbnails are unaffected (image endpoint works).
- **Golazos: 6 null thumbnails** (editions 577, 578, …) — trivial; the other 575 are on `assets.laligagolazos.com` (verify live). No Golazos IPFS catalog either.
- **UFC** thumbnails are all IPFS (518/518) — fine.

## 4. AllDay "scarce + below-FMV" board — built, validated, DROPPED (data-gated)

Investigated the AllDay analog of TS underpriced-serials. Built `allday_scarce_deals_board` (scarcity × floor-below-FMV), then **dropped it** after validation: the naive board returned 151 rows **dominated by fake deals** — inflated thin-FMV LOW-confidence editions (e.g. a Base COMMON reading FMV $212.50 from one outlier sale, "99.5% off" a $1 floor), the exact fake-deal class the TS deal boards guard against. With honest guards (HIGH/MEDIUM confidence FMV + ≥$10 floor) only **3-9 trustworthy deals** survive (Drake Maye Rookie Debut 37% off, Caleb Williams 32%, Joe Montana RARE) — too sparse for a dedicated public surface. **Conclusion: data-gated on AllDay FMV depth** (same gate as AllDay serial-FMV — needs the AllDay sales-history backfill to deepen). Revisit when AllDay HIGH/MEDIUM coverage grows; if built then, it MUST carry the thin-FMV / `low_confidence_fmv` guard the TS boards use. No view left in the DB.

## 5. Deepen AllDay FMV — investigated; it's mostly genuine low-liquidity, not a fixable data gap

Investigated "point the AllDay sales-history backfill harder." Findings (live-measured 2026-06-24):
- **The writer is already optimal.** AllDay's latest FMV is on `fmv-recalc 1.7.0` (249 HIGH / 654 MEDIUM / 2,910 LOW / 1,666 NO_DATA cold-tail / 600 ASK_ONLY) — the strong sales-based model, **not** the weak `allday-gql-v1`. The original audit's "make 1.7.0 authoritative" item is effectively done. No writer lever.
- **No AllDay sales-history backfill pipeline exists** — AllDay has only forward indexing (`allday-sales-indexer`, V1 Dapper + V2). Total AllDay sales **23,447**, oldest **2023-11-30** (AllDay launched 2021 → ~2 years of pre-2023 history is unindexed), only **318** sales >180d old.
- **The thinness is substantially real liquidity, not missing data.** **1,466 of 2,910 LOW editions have ≤2 sales in 90 days.** FMV *confidence* is recency-driven (`sales_count_30d`), so backfilling old sales will **not** lift these to HIGH/MEDIUM — AllDay simply trades less than Top Shot, and the 904 HIGH+MED honestly reflect its liquid editions.

**What a historical backfill WOULD do (modest, optional):** improve **coverage** — NO_DATA editions that traded 2021–2023 would get a (stale/SALES_ONLY) price instead of "no FMV" — and enrich the FMV history charts. It would **not** make AllDay's HIGH/MEDIUM% match TS.

**If pursued (worker build — not Cowork-shippable; needs on-chain reads + `SPORK_PROXY_SECRET`/service-role):** mirror `app/api/cron/topshot-sales-history-backfill/route.ts` for AllDay — walk historical block ranges (Nov-2023 back to AllDay launch) via `spork-proxy`, scan **V1 Dapper** `A.4eb8a10cb9f87357.NFTStorefront.ListingCompleted` events filtered to `nftType ENDS '.AllDay.NFT'`, decode via `lib/dapper-v1-tx-decode.ts` (buyer = `A.e4cf4bdc1751c65d.AllDay.Deposit.to`; price = `DapperUtilityCoin.TokensWithdrawn`), insert `source='onchain_dapper_v1'`, let `allday-unmapped-resolver` map editions. Price-uncertain rows → `unmapped_sales`. **Verify:** AllDay NO_DATA count drops; `v_fmv_sanity_flags` stays 0; no fake HIGH/MED inflation.

**Recommendation:** low-ROI for a secondary-market collection — AllDay FMV deepens organically as forward indexing accumulates. Build the backfill only if AllDay FMV-chart depth / NO_DATA coverage becomes a priority. **No Cowork ship moves this; the writer is already correct and the rest is liquidity-bound.**

## Guardrails
- Direct to `main`. No branches, no PRs. PowerShell `git`; re-verify push `git rev-list --count origin/main..HEAD` → 0.
- `curl` fails silently in Git Bash for Vercel REST — PowerShell `Invoke-WebRequest`. Vercel Pro `maxDuration` cap 800s.
- Run smoke + confirm deploy READY before done.

## Expected end state
Two migrations repo-synced + ledgered; the WNBA/Base-Set catalog gap either backfilled (then recovery migrations re-run, dead-`editions/` count → near 0) or documented as no-on-chain-art. No app deploy needed for the media recovery itself — `thumbnail_url`/`video_url` are now correct at the source for 7,517/7,499 legacy editions, fixing the 111 mintless residual and every non-RPC consumer (/share, OG cards, sitemaps).
