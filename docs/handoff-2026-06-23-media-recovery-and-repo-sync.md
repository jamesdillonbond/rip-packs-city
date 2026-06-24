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

## 3. Optional net-new (not a bug — for Trevor's call)

- **AllDay "scarce + below-FMV" board** — cross `allday_scarcity_board` with the deal data (mirror the TS underpriced-serials board) to surface scarce AllDay editions listed below FMV. New view + `/insights/` page. Net-new feature, not an unresolved bug — build only on explicit direction.

## Guardrails
- Direct to `main`. No branches, no PRs. PowerShell `git`; re-verify push `git rev-list --count origin/main..HEAD` → 0.
- `curl` fails silently in Git Bash for Vercel REST — PowerShell `Invoke-WebRequest`. Vercel Pro `maxDuration` cap 800s.
- Run smoke + confirm deploy READY before done.

## Expected end state
Two migrations repo-synced + ledgered; the WNBA/Base-Set catalog gap either backfilled (then recovery migrations re-run, dead-`editions/` count → near 0) or documented as no-on-chain-art. No app deploy needed for the media recovery itself — `thumbnail_url`/`video_url` are now correct at the source for 7,517/7,499 legacy editions, fixing the 111 mintless residual and every non-RPC consumer (/share, OG cards, sitemaps).
