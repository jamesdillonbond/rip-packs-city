# Claude Code handoff — remaining work after the 2026-07-01/02 full audit

Paste this whole doc to Claude Code. Read on desktop (normal markdown). This is the **consolidated, standalone** handoff — it supersedes the scattered notes in `docs/handoff-2026-07-02-item2-allday-ev-item8.md` (kept for detail/history). Everything here is open; everything in "Already shipped" is done — do not redo it.

**Working agreement (non-negotiable):** commit + push directly to `main`, no branches, no PRs. `apply_migration` for DDL, `execute_sql` for reads. Run `SELECT public.check_public_security_invariants();` (must stay `[]`) after any migration. Verify each item live (deploy READY + the item's own detector) before calling it done. Every migration gets a revert path. Supabase project `bxcqstmqfzmuolpuynti`; TS collection_id `95f28a17-224a-4025-96ad-adf8a4c63bfd`; AllDay `dee28451-5d62-409e-a1ad-a83f763ac070`. Do NOT hand-write FMV values — change the model/guard and let the canonical recalc reprice.

**Platform state at handoff (all verified live 2026-07-02 ~05:10Z):** security 0/0/0/0, trust-health 15/15 ok, 0 stalled pipelines, editions flat (TS 17,489 / AllDay 6,191 / Golazos 581 / UFC 518), F1 impossible-serials **0**, v8 AllDay EV cron cycling. Operator items already handled by Trevor: Vercel spend cap raised; Supabase PostgREST pool → 40.

---

## P1 — Market + Sniper show fake -98/-99% "deals" (MODERATE–HIGH; core surface)

> **STATUS UPDATE 2026-07-02 (post-P1a):** P1a (`dc8e103`, `topshot_fmv_display_guard` + `lib/fmv-display-guard.ts`) shipped and is built correctly — the guard table is populated + secure (1,381 rows, RLS-on), the lib clamps `min(fmv, max_sale_90d)` and flags thin data, and **`/api/sniper-feed` wires it correctly** (passes `momentId` at line 1295 and the series-resolved `editionKey`=setID:playID at line 1451). **But `/api/market` is still non-functional — it passes the WRONG key.** At `app/api/market/route.ts` line 327 (modern path) and 479 (cached path) it calls `guardTopshotFmv(fmvGuard, editionKey, rawFmv)`, where `editionKey` is derived from an **ambiguous `(player_name, set_name)` lookup** (lines 312–322) — a player has many editions in "Base Set" across series, so it resolves to null (or the wrong series). The guard is keyed by the edition's own integer `setID:playID`, which on the row is **`r.moment_id`** (the `momentId` field). Verified against the live cache-busted API: De'Anthony Melton `51:1952` still returns `fmv 42.5, discount 99.1, lowConfidenceFmv false` even though it's in the guard table with `fmv_exceeds_max=true`.
>
> **THE FIX (one line, both call sites, type-safe):** in `app/api/market/route.ts`, change `guardTopshotFmv(fmvGuard, editionKey, rawFmv)` → `guardTopshotFmv(fmvGuard, r.moment_id ?? editionKey, rawFmv)` at both line ~327 and ~479 (`?? editionKey` keeps the cached/non-TS path unchanged since guard only applies when `isTopShot`). `r.moment_id` is the integer `setID:playID` for TS rows (confirmed in the live response); the guard lib already handles the `::` parallel split. tsc-safe (`guardTopshotFmv` accepts `string|null|undefined`).
>
> **Verify:** re-hit `/api/market?collectionId=95f28a17-224a-4025-96ad-adf8a4c63bfd&sort=recent&page=1&limit=50&cb=x` — De'Anthony Melton `51:1952` should return `fmv ≈ 0.33` (clamped), `lowConfidenceFmv true`, and its `discount` should collapse from 99% to ~0; the board should no longer headline a wall of -98/-99%. Detector below → ~0. **Revert:** change the key arg back to `editionKey`.
>
> **VERIFIED 2026-07-02 after `c5ed36d` (the key fix shipped):** the market-key fix WORKS for guarded editions — De'Anthony Melton `51:1952` (in guard, `fmv_exceeds_max=true`, max_sale_90d $0.33) now clamps to $0.33 and dropped out of the top-discount results. P2 dedup trigger verified healthy (AllDay ingesting 1,301/3h, dups 0, invariants `[]`). **BUT a residual class of fake deals remains that the guard does NOT catch — this is now the strongest reason P1b (model) is required, not optional:** high-volume **bimodal** editions slip through both guard criteria. Live examples on `discount_desc`: Derrick White `218:8204` FMV **$23.80** vs 90d median **$0.29** (92 sales, max $28) still shows `-98.4% / lowConfidenceFmv false`; Vince Williams `218:8240` FMV $7 vs median $0.29 (119 sales); Anthony Edwards `218:7908` FMV $7.42 vs median $0.50 (80 sales). They evade the guard because `is_thin` requires **<15 sales** (they have 80–120) and `fmv_exceeds_max` requires FMV > 90d **max** (their FMV sits *below* the real $28 outlier that inflated the WAP). **Critically, the display guard's clamp-to-`max_sale_90d` cannot fix these** — the max IS the outlier. Two ways to close it: (a) broaden the guard population to also flag `fmv > 3× median_90d` (≈494 TS editions — my original detector) AND clamp effective FMV toward the **median** (not max) for that class; or (b) ship P1b so the model stops over-weighting the outlier in the first place. P1b is the clean fix.
>
> P1b (FMV model) below is unchanged — still the durable root-cause fix, still review-gated, and now demonstrably necessary (the display guard alone can't de-fake the bimodal class).


The single most impactful open item. The TS **Market** tab (`/nba-top-shot/market`) default board is a wall of `-98%/-99%` discounts with impossible FMVs — e.g. De'Anthony Melton Base Set S4 `51:1952` shows **FMV $42.50** next to a $0.38 ask; Alex Len `26:1028` $25.50; Joel Embiid `26:745` $21.25; Pat Connaughton `51:2563` $17.00 — all $0.30–0.50 role-player commons. Same effect inflates the **Sniper** tab's "avg 79.7% off". A board full of impossible bargains reads as broken and undercuts the "deals below FMV" value prop.

**Root cause (measured, NOT staleness):** the FMV WAP model over-weights old high sales on thin-volume editions. `51:1952` genuinely sold up to **$50 in early 2026** (last >$5 sale 2026-03-28), then crashed to ~$0.30 (90d avg $0.27 / max $0.33) — but FMV is still $42.50 **even though it was recalc'd within 7d**. The recalc runs; the model reproduces the inflated value because a ~3-month-old outlier still dominates a 16-sale edition. **Force-recalc will NOT fix it — the model has to change.**

**Scale (TS canonical, ≥5 sales/90d):** 15 editions with FMV > 3× their 90d **max** sale (2 > 10×; 11 also stale >3d) — the clear-cut wrong ones; 494 with FMV > 3× 90d **median** (the broader thin class).

**Surface gap (grep-confirmed):** the `low_confidence`/`thin_fmv` guard is applied on the Deals board (`app/insights/deals/*`, `app/api/public/insights/deals/route.ts`), pack-sniper, pack pages, allday-pack-reality — but NOT in `app/(collections)/[collection]/market/page.tsx`, `app/(collections)/[collection]/sniper/page.tsx`, or `app/api/sniper-feed/route.ts`.

**Fix P1a — display guard (do first; high leverage, low risk):** apply the existing thin-FMV / `low_confidence_fmv` guard (source table `topshot_thin_fmv_editions`, refreshed by `refresh_topshot_thin_fmv_editions()`) to the Market tab + Sniper tab + `sniper-feed`, exactly as the Deals board does. Add a hard sanity rule: **never show a discount vs an FMV that exceeds the edition's own 90d max sale** — clamp or flag those rows (`⚠ thin data — FMV uncertain`, muted, de-emphasize the discount). This immediately de-fakes both boards and catches the 15 egregious ones. No FMV values change; it's read-side.

**Fix P1b — FMV model (durable root cause; Trevor/CC review-gated, it's central pricing logic). MEASURED + VALIDATED PROPOSAL (2026-07-02):**

The WAP over-weights high-outlier sales on bimodal editions (low median + occasional spike). **Scope: 176 TS editions** (≥15 sales/90d, `fmv > 3× median` AND `fmv > 1.5× p90`) that the P1a guard misses. Validated fix: **clamp FMV to `LEAST(fmv, p90_90d × 1.5)`** — anchor on the 90th percentile of 90d sales (×1.5 headroom), NOT the median (over-clips wide editions) and NOT the max (the max IS the outlier). Measured before→after on the worst offenders:

| edition | player | n90 | median | p90 | max | current FMV | → clamped |
|---|---|---|---|---|---|---|---|
| 8:62 | Giannis | 23 | $1 | $2 | $7 | **$2,924** | $3 |
| 171:6424 | Cade Cunningham | 78 | $0.30 | $0.45 | $200 | $170 | $0.68 |
| 218:8204 | Derrick White | 92 | $0.29 | $0.95 | $28 | $23.80 | $1.43 |
| 26:745 | Joel Embiid | 21 | $0.27 | $1.00 | $25 | $21.25 | $1.50 |
| 168:6336 | Andrew Wiggins | 22 | $0.23 | $0.33 | $22 | $18.70 | $0.50 |
| 26:650 | Terry Rozier | 39 | $0.05 | $5.20 | $15 | $10.80 | $7.80 (wide — correctly not over-clipped) |

Two ways to ship it: **(a) model (cleanest, fixes everywhere):** apply the `LEAST(fmv, p90×1.5)` clamp as a post-step in `app/api/fmv-recalc` so `fmv_snapshots` itself is bounded — fixes deal boards, alerts, pack-EV, concierge, FMV API, market, sniper in one place. Central pricing change → **must be reviewed** (verify it doesn't clip legit HIGH/ULTIMATE editions; those have p90 ≈ FMV so they're untouched, but confirm). **(b) display guard (market/sniper only, no `fmv_snapshots` change):** add a `p90_90d` column to `topshot_fmv_display_guard`, broaden its population to the 176 (flag `fmv > 1.5× p90`), and change `lib/fmv-display-guard.ts` to clamp to `LEAST(fmv, p90×1.5)` instead of `max_sale_90d`. Lower blast radius but only de-fakes the two boards. Do NOT hand-write FMVs either way. Detector below (`fmv > 3× max` and the broader `fmv > 3× median`) → both trend down.

**Detector (track to ~0 after the fix):**
```sql
WITH ts AS (SELECT '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid cid),
latest AS (SELECT DISTINCT ON (edition_id) edition_id, fmv_usd FROM fmv_snapshots WHERE collection_id=(SELECT cid FROM ts) ORDER BY edition_id, computed_at DESC),
s90 AS (SELECT edition_id, count(*) n, max(price_usd) mx FROM sales WHERE collection_id=(SELECT cid FROM ts) AND sold_at>now()-interval '90 days' GROUP BY 1)
SELECT count(*) FILTER (WHERE l.fmv_usd > 3*s.mx AND s.n>=5) AS fmv_gt_3x_maxsale
FROM editions e JOIN latest l ON l.edition_id=e.id JOIN s90 s ON s.edition_id=e.id
WHERE e.collection_id=(SELECT cid FROM ts) AND e.external_id ~ '^[0-9]+:[0-9]+$';
```

## P2 — All Day cross-source duplicate sales (LOW–MED; durable writer fix)

CC's daily `dedup_allday_cross_source_sales()` sweeper collapses these, but the **writer keeps producing them** (~25/backfill-burst, ~0.08% of 90d AllDay sales): the `allday_studio_history_v1` backfill and the `onchain`/`onchain_dapper_v1/v2` indexers ingest the same economic sale under different tx representations, so tx_hash dedup misses them. Durable fix = an ingest-time cross-source dedup key (`nft_id + round(price_usd,2) + date_trunc('day',sold_at)`) that **preserves the sweeper's keep-richer semantics** (keep the most-resolved row — the earlier analysis correctly rejected a naive skip-if-exists trigger because it keeps whichever row arrives first, often the poorer studio row). Detector: same `nft_id`+price+day across >1 `source`.

## P3 — UFC (ipfs.io) related-thumbnails still slow/blank (LOW; UFC is Flow-historical)

CC's `1c1878b` fixed the **hero** via the `/api/public/ipfs-media/[cid]` edge proxy (verified: hero now proxied + renders). But on the same edition page, the **related / "similar moments" thumbnails still hit `ipfs.io` directly** (6 CIDs on a cache-busted load) → slow/blank. Extend the `lib/ipfs-media.ts` rewrite to the related-moments grid and any other UFC-thumbnail surface (collection tab, set pages, sniper/insights thumbnails). Route works + SSRF guard is sound; this is just coverage.

## P4 — Item 8: All Day enrichment (LOW; needs external data / deployed routes)

Confirmed blocked from a Cowork/MCP session — real builds, schedule by priority:
- **Jersey-match special serial:** no jersey data anywhere in the DB (`editions.jersey_number` 0/6191 AND `players.jersey_number` 0/1517 for AllDay). Needs a studio-platform GQL / NFL-roster jersey source → a `backfill-allday-jersey` pipeline → populate `editions.jersey_number` → the special-serials RPC picks it up.
- **Buyer recovery:** ~12.6% of AllDay 90d sales have an unresolved buyer (1,579 Flowty-router `0x3cdbb3d569211ff3` + 2,261 null of 30,352). Recover via `fetchTxBuyers` / forward-`Deposit`-scan (AllDay real buyer = `A.e4cf4bdc1751c65d.AllDay.Deposit.to`) from a deployed route with proxy creds. Same class applies to Golazos historical sales (`— —` buyers).
- **Username-resolver tail:** operational — raise `wallet-username-resolver` batch/frequency; prioritize high-value/parallel buyers (TS is 97.7% resolved, the tail skews to parallel buyers).

## P5 — Pinnacle Pack EV (GATED on Trevor's go; review-gated pricing on a near-dead surface)

Fully investigated (`docs/handoff-2026-07-01-pinnacle-pack-ev-measured-finding.md`): the source (`searchDistributions` GQL) works, the **supply-weighted** model is validated ($4.99 pack → ~$27.87 EV / 5.6×), and **uniform is garbage (531× on parallels — do NOT ship it).** But Pinnacle has had **exactly one pack drop ever ("Summer Splash"), mostly sold out** — so payoff is ~zero today; the value is auto-coverage of the *next* drop. Build (when greenlit): Pinnacle pack indexer → `pack_distributions` + pool with supply-weighted (`∝ total_supply`) drop weights, group facets into the parent pack by title+price, flag `low_confidence` on ASK_ONLY/thin parallels, then add the Packs tab. Reasonable to defer until Pinnacle drops packs again.

## P6 — Analytics "Unknown moment" in buybacks (LOW; cosmetic)

The Analytics page "Recent Buybacks" occasionally shows "Unknown moment" (the buyback event's moment/edition didn't resolve to a name). Resolve the moment name in the buyback query or hide unresolved rows.

---

## Already shipped + verified this engagement — do NOT redo
- **F1 parallel mis-attribution** — writer guard (`a9c011c`) + onchain-resolver Step-4e guard (`8064801`) + one-time re-keys (`audit_20260701_*` + `audit_20260702_*`, backup tables RLS-on). Detector **0**, holding.
- **F4 reward-pack dead KPIs** suppressed (`c5db7a4`, verified live).
- **Item 2 All Day Pack EV** → circulation-weighted (edge fn v8 = Supabase version 25; repo synced `107a897`; pool primed 590 weights; realized-EV board 147→420). Headline self-heals as the 30-min cron cycles.
- **Item 5 Pinnacle render enrichment** (buyer/seller + serial + FMV chart, `7fb73d5`).
- **Item 7 Pinnacle polish** (`9052976`) + Golazos banner copy.
- **UFC hero** ipfs proxy (`1c1878b`) — hero renders; only the related-thumbnails remain (P3).
- **Serial "#0"→"—"** display; **All Day dedup** one-time collapse; **F2 sweeper** cron.
- **Insights boards (16), concierge, share/profile, sets/teams, all 5 collections' edition templates** — QA'd healthy.
- **Operator (Trevor):** Vercel spend cap raised; Supabase pool → 40.

## Suggested order
P1a (de-fake the core boards — quick, high-impact) → P2 (AllDay dedup key) → P3 (UFC thumbnails) → P1b (FMV model, with Trevor's review) → P6 (cosmetic) → P4/P5 when the data source / a new drop / Trevor's go arrives.
