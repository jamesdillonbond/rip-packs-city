# Handoff — Pinnacle per-render_id FMV (sales re-key shipped; recompute + floor-ask are yours)

## Context — what Cowork shipped live ahead of this (DB, applied)

- Migration `audit_20260606_pinnacle_sales_render_id_column`: added `pinnacle_sales.render_id` (text, NULL = unresolved) + `idx_pinnacle_sales_render_id` + partial `idx_pinnacle_sales_render_id_null` (drain queue). ADDITIVE + INERT — nothing computes from it yet. Column comment documents intent. Revert: `ALTER TABLE public.pinnacle_sales DROP COLUMN render_id;` (drops both indexes with it).
- Backfilled from wmc (held pins only, exact mapping, 0 conflicting moment_ids): **2,816 / 13,143 sales re-keyed (21.4%)**. The remaining **10,327** need the GraphQL NFT-resolve (item 1).

## Why this matters (measured, not theoretical)

- 311 of 336 wmc-seen legacy keys span MULTIPLE render_ids (worst: 26 pins on one key). **86% of all Pinnacle sales (11,265/13,143) sit on blended keys** — so today's per-legacy-key FMV mixes different characters' sales nearly everywhere.
- Concrete: `STAR-OEV1-SWHM:Golden:1` (12 helmets, 259 re-keyed sales) — current blended FMV **$1.87 for all twelve**, but per-render reality: Kylo Ren Helmet avg **$4.64** (max $15, 61 sales) vs the other 11 at $1.29–$2.22. Kylo underpriced ~60%, commons overpriced ~40%.
- Bonus: 71 sales with NULL legacy edition_id resolved cleanly by render_id — the re-key also recovers previously unattributable sales.

## Item 1 — drain the 10,327 unresolved sales + stamp at write time

- One-time: an admin route in the `backfill-pinnacle-catalog` mold (`/api/admin/backfill-pinnacle-sales-render-id`, Bearer RPC_ADMIN_TOKEN, GET/POST): page DISTINCT `nft_id` FROM `pinnacle_sales` WHERE `render_id IS NULL` (use the partial index), resolve via studio-platform GraphQL `searchPinnacleNft(searchInput:{filters:[{id:{in:[...ids]}}]})` → `node.render_id`, ~200 ids/batch ≈ 52 calls — comfortably one ~60–120s run. Endpoint + auth + gotchas (Sort shape, ÷1e8) in docs/handoff-2026-06-06-pinnacle-graphql-and-render-id-rekey.md. Log pipeline_runs (`pinnacle-sales-render-id-backfill`).
- Ongoing: stamp `render_id` at write time in `pinnacle-events-ingest` (it has nft_id; batch-resolve per tick via the same query) — OR fold a small drain into the hourly `pinnacle-wmc-render-id` cron (it already does NFT→render resolves; add a Q2 for sales rows). Either way: new sales should never sit unresolved for more than a tick.
- Sanity check after the drain: re-run the wmc-agreement test — sales whose nft_id IS in wmc must have GraphQL render_id == wmc.render_id (it was 0-conflict on the first 2,816).

## Item 2 — FMV recompute re-key (PRICING LOGIC — review before shipping, don't let the night pass auto-ship)

- Today: `pinnacle_fmv_recalc` / `pinnacle_fmv_recalc_all` group by legacy `edition_id`; `pinnacle_fmv_snapshots.edition_id` = legacy key; replace-in-place generations; the writer logs NOTHING to pipeline_runs (the known freshness blind spot).
- Re-key: add `render_id` to `pinnacle_fmv_snapshots`, compute per render_id (sales WAP over `pinnacle_sales WHERE render_id=...`), keep the legacy key on the row during transition so readers can cut over gradually. Expect honest confidence DROPS on thin renders (12-way splits mean smaller samples — that's correct, not a regression; the blend was fake confidence).
- While in there: make the writer log `pipeline_runs` (pipeline `pinnacle-fmv-recalc`) so detect_stalled_pipelines can ever see it, then watchlist it after 48h cadence.
- Readers to cut over after recompute: `populate_pinnacle_wmc_fmv` (join by render_id instead of edition_key), `get_pinnacle_edition_fmv`, the scarcity board + pin pages (the deferred page cutover), concierge `get_fmv` Pinnacle path (CLAUDE.md rule #1 — the triple-match join becomes a render_id join, simpler AND safer).

## Item 3 — floor ask per render (the FMV-vs-floor surfacing)

- Extend the daily catalog backfill (or a sibling) to also pull per-edition floor: `searchPinnacleNft` filtered `[{edition:{id:{in:[...]}}},{listing:{price:{gte:1}}}]` sorted `{listing:{price:{priority:1,direction:"ASC"}}}` first:1 — or explore `searchPinnacleNftAggregation` for bulk floors. Write `pinnacle_catalog.floor_ask` + `floor_ask_updated_at` (`price` ÷ 1e8).
- Product use: where FMV ≫ floor (e.g. >1.3x) on thin editions, show the floor alongside FMV (the Spinning Wheel $247-FMV-vs-$165-floor pattern). Cross-check stands: RPC's stored asks matched live exactly, so the listings indexer can stay the intraday source; this is the daily corroboration layer.

## Guardrails

- Item 2 is central pricing logic: review + soak gates apply; explicitly NOT for autonomous/night-pass shipping. Items 1 and 3 are data plumbing.
- Per-render confidence will be thinner — do not "fix" that by loosening gates; the blend was overstating confidence.
- Verify end-state in DB after each item (counts above are the baselines). Direct-to-main, PowerShell git, www host for crons — usual rules.

## Verify / end state

- Item 1: `SELECT count(*), count(render_id) FROM pinnacle_sales` → 13,143 / ~13,1xx (some burned/edge NFTs may not resolve; report the residual). 0 wmc disagreements.
- Item 2: per-render snapshots exist for every render with sales (~360+ renders vs 428 legacy keys today); Kylo Ren Golden prices ~$4.6, its set-mates ~$1.3–2.2; wmc Pinnacle fmv_usd re-populates per pin.
- Item 3: `pinnacle_catalog.floor_ask` fresh daily; UI can show floor next to FMV.
- Net: Pinnacle FMV stops blending characters — pricing finally matches the pin you actually hold, on the same render_id spine as the catalog/images/serials shipped in 2e8cbd1.
