# Wave 2 — post-cutover consistency: 5 DB fixes SHIPPED (Cowork), 3 code items for CC, wave-3 ledger

Context: after Wave 1a (wmc per-render FMV) + Wave 1b (board + pin pages), the remaining `pinnacle_fmv_snapshots` readers disagreed with the render-spine surfaces. Cowork audited all 30 reader functions + 3 views (2026-06-06 ~23:30Z), shipped the DB-only fixes live, and packages the rest here. All five migrations verified against Dumbo `0x37a7e864611c7a85` + Trevor `0xbd94cade097e50ac`.

## A. SHIPPED live by Cowork (5 migrations, same-signature replaces, grants preserved)

1. **`audit_20260606_cross_collection_portfolio_pinnacle_wmc`** — `get_cross_collection_portfolio` reported Pinnacle **$0.00** (live bug on /api/portfolio + weekly digest). Two defects: the collections loop didn't exclude `disney_pinnacle` (shared-schema `get_wallet_summary` emitted 202 moments/$0 — its joins can't price Pinnacle keys), and the dedicated leg read `pinnacle_nft_map.owner` (empty) joined `pe.external_id = pn.edition_key` (wrong column). Now: loop excludes Pinnacle; Pinnacle slice = `count/SUM(fmv_usd)` from wmc. Verified: Dumbo Pinnacle 0 → **$1,405.32**, total 7,330.16 → **8,748.99**; Trevor Pinnacle $983.59.
2. **`audit_20260606_cross_collection_deals_dedupe_overload_pinnacle_catalog`** — `get_cross_collection_deals` had TWO overloads with identical param NAMES (`(p_min_discount int, p_limit int)` + `(p_limit int, p_min_discount numeric)`) → **every PostgREST named-arg call failed PGRST203; pg_stat showed 0 lifetime calls on both** — the route + digest deals have NEVER successfully called it. Dropped the stale int,int overload; replaced the rich one with the Pinnacle leg re-pointed from dead `pinnacle_cached_listings` (142 frozen Flowty rows, joined through the same broken `pe.external_id=edition_key` chain → permanently 0 rows) to `pinnacle_catalog` (live `floor_ask` vs per-render `fmv_usd`, proxy thumbnails, `disneypinnacle.com/pin/<edition_id>` buy URLs).
3. **`audit_20260606_cross_collection_deals_pinnacle_liquidity_gate`** — first cut surfaced a 90.9% "deal" (SEV2-TOYS-BUZZ-S1: 4 thin sales WAP'd to $55 vs $5 live floor on a 2,228-mint Standard — fabricated). Measured: at `fmv_sales_count_30d >= 8` max discount falls to 35.6% (all plausible). Gate added alongside HIGH/MEDIUM confidence + floor-freshness ≤3d. Current output: 15 deals ≥15%, all HIGH, max 35.6% (Mirabel/BB-8/Gurgle/Viper Probe Droid/Skiff Guard).
4. **`audit_20260606_holdings_summary_pinnacle_wmc_fmv`** — `holdings_summary` (concierge / workers/rpc-mcp-proxy) resolved Pinnacle via the legacy blend → Dumbo $1,007.32 vs correct $1,405.32. Pinnacle branch now reads `wmc.fmv_usd`; dropped the `latest_pinnacle_fmv` CTE + pe/pf joins; shared collections byte-for-byte unchanged. Verified both wallets match `get_cross_collection_portfolio` exactly.
5. **`audit_20260606_wallet_moments_with_fmv_pinnacle_render_rekey`** — `get_wallet_moments_with_fmv` (5 routes incl. the Pinnacle collection page) was the LAST wallet-facing surface on the pre-re-key path: identity via `pinnacle_nft_map → pinnacle_editions` (set-level → wrong characters), FMV via legacy snapshots, serials hardcoded NULL, placeholder thumbnails. `base_pinnacle` now reads wmc (re-keyed identity + serials + proxy `image_url`) + `pinnacle_catalog` by `wmc.render_id` (fmv/confidence/live floor as `low_ask`/`fmv_algo_version`). ADDITIVE new field `render_id` in both branches (NULL for non-Pinnacle); existing keys unchanged. Verified: Dumbo 202 pins — Genie's Lamp $537.78/serial 204/floor $650, Carefree Companions $196.10/serial 90, Spinning Wheel $163.60/serial 60, all proxy thumbs; TS branch untouched (596, Butler $500 STALE).

## B. CC items (code-side, wave 2)

1. **send-digest deals consumption (3-line fix, [app/api/send-digest/route.ts](app/api/send-digest/route.ts) ~L34-54).** Even with the RPC fixed, the dealsBlock can never render: (a) `Array.isArray(deals)` — the RPC returns an OBJECT `{total_deals, deals[], per_collection[]}`, so read `deals?.deals`; (b) field names — it renders `d.price` / `d.discount_pct` / `d.pct_below_fmv`, but rows carry `ask_price` / `discount`. Fix both. The portfolio block needs nothing (shape already matches). Optional: surface `thumbnail_url` (absolute-URL it: `origin + path` for the Pinnacle proxy paths).
2. **`get_moment_detail` Pinnacle leg → disambiguation pattern ([app/moment/[id]/page.tsx](app/moment/[id]/page.tsx) + the SECDEF fn).** The `kind='pinnacle_edition'` branch serves set-level identity + legacy blended FMV. A render-true rewrite is one-to-many (edition_key → N renders), so it needs the wave-1b product pattern: return the key's renders (identity + per-render FMV from `pinnacle_catalog`) and have the page render a "Pick a pin" list linking to `/pinnacle/moment/<render_id>`, exactly like the wave-1b legacy-URL disambiguation. Low traffic (QR/Trophy Slab links are TS), so this is polish, not a fire. Page + fn move in ONE deploy.

   **SHIPPED (CC, 2026-06-06).** Migration `audit_20260606_get_moment_detail_pinnacle_renders_additive` adds an ADDITIVE `renders[]` (render_id, character_name, set_name, variant, total_minted, fmv_usd, fmv_confidence::text, floor_ask, proxy thumbnail) to the pinnacle leg — joined from `pinnacle_catalog` by `legacy_edition_key = pe.edition_key`, ordered by fmv desc. Legacy `edition`/`fmv`/`recent_sales`/`similar` keys untouched (API + OG routes unaffected); TS/AllDay/Golazos/UFC branches byte-for-byte unchanged. The page disambiguates: `resolved.kind='pinnacle_edition'` with >1 render → `PinnacleDisambiguation` "Pick a pin" list; exactly 1 → `redirect()` to its `/pinnacle/moment/<render_id>`; 0 (numeric-id legacy rows, no render map) → falls through to the set-level view. Verified live: `STAR-OEV1-SWHM:Digital Display:1` → 12 renders, Kylo Ren Helmet $277.59. Revert: re-apply the prior fn body in §E.6.
3. **`/api/cross-collection-deals` route ([app/api/cross-collection-deals/route.ts](app/api/cross-collection-deals/route.ts)).** Now functional (was PGRST203 forever). No repo consumers found — either wire it into a surface (home/insights deal strip is a natural fit; data is honest now) or leave as API. FYI shape: `{total_deals, deals[], per_collection[]}`; deals currently 100% Pinnacle because `cached_listings` froze with Flowty (TS asks live in `badge_editions.low_ask`, a different leg — adding a TS leg from badge_editions would make this a genuinely cross-collection feed again, worth considering while in there).

## C. Wave 3 ledger (retire at zero readers — do NOT do piecemeal)

- **Orphans (0 repo callers, verified by grep 2026-06-06):** `get_pinnacle_edition_fmv(p_edition_key)`, `get_pinnacle_overview()`, `get_pinnacle_top_movers(int,int)`, `moment_detail(p_wallet,p_moment_id)`, `get_pinnacle_moment_detail(p_id)`. Re-verify grep at retirement, then DROP.
- **Health/coverage surfaces reading `pinnacle_fmv_snapshots` as a freshness signal:** views `data_coverage_dashboard`, `data_quality`, `pipeline_health`; fns `health_check`, `pinnacle_health_check`, `analytics_data_quality_overview`, `analytics_liquidity_distribution`, `analytics_smoke_run`. Re-point at `pinnacle_catalog.fmv_computed_at` when the legacy table drops.
- **Entity/team fns with vestigial Pinnacle legs:** `get_edition_detail`, `get_edition_fmv_history`, `get_player_detail/editions`, `get_set_detail/editions`, `get_series_detail/editions`, `get_team_*` (5) — no live Pinnacle entity/team pages route through these; clean the legs at retirement rather than churning 15 fns now.
- **Legacy writer chain stays until all above migrate:** `pinnacle_fmv_from_listings`, `pinnacle_fmv_from_sales`, `pinnacle_fmv_recalc_all`, `bridge_pinnacle_fmv_to_main`, table `pinnacle_fmv_snapshots`. `pinnacle-sync` keeps running BOTH writers.

## D. Verify (post-CC-ship)

- Digest dry-run renders a Top Deals list with real asks/discounts; portfolio block shows Pinnacle ≈ card value.
- `/moment/<a pinnacle edition_key>` renders the disambiguation list; TS moment pages unchanged.
- `SELECT (get_cross_collection_deals(p_limit:=5,p_min_discount:=15))->'per_collection';` — Pinnacle present, max discount sane (≤ ~40%).

## E. Reverts (prior bodies, verbatim)

Each migration comment points here. To revert, `CREATE OR REPLACE` (or re-`CREATE`) the bodies below; for item 2 also re-create the dropped overload.

### E.1 get_cross_collection_portfolio — prior body

```sql
CREATE OR REPLACE FUNCTION public.get_cross_collection_portfolio(p_wallet text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_collection RECORD;
  v_summary jsonb;
  v_results jsonb := '[]'::jsonb;
  v_total_moments int := 0;
  v_total_fmv numeric := 0;
  v_total_locked_fmv numeric := 0;
  v_total_unlocked_fmv numeric := 0;
  v_total_locked int := 0;
  v_total_unlocked int := 0;
  v_total_cost_basis numeric := 0;
  v_total_pnl numeric := 0;
  v_pin_count int;
  v_pin_fmv numeric;
BEGIN
  FOR v_collection IN
    SELECT id, name, slug FROM collections ORDER BY name
  LOOP
    IF EXISTS (
      SELECT 1 FROM wallet_moments_cache 
      WHERE wallet_address = p_wallet AND collection_id = v_collection.id
      LIMIT 1
    ) THEN
      v_summary := get_wallet_summary(p_wallet, v_collection.id);
      v_total_moments := v_total_moments + COALESCE((v_summary->>'total_moments')::int, 0);
      v_total_fmv := v_total_fmv + COALESCE((v_summary->>'wallet_fmv')::numeric, 0);
      v_total_locked_fmv := v_total_locked_fmv + COALESCE((v_summary->>'locked_fmv')::numeric, 0);
      v_total_unlocked_fmv := v_total_unlocked_fmv + COALESCE((v_summary->>'unlocked_fmv')::numeric, 0);
      v_total_locked := v_total_locked + COALESCE((v_summary->>'locked_count')::int, 0);
      v_total_unlocked := v_total_unlocked + COALESCE((v_summary->>'unlocked_count')::int, 0);
      v_total_cost_basis := v_total_cost_basis + COALESCE((v_summary->>'cost_basis')::numeric, 0);
      v_total_pnl := v_total_pnl + COALESCE((v_summary->>'pnl')::numeric, 0);
      v_results := v_results || jsonb_build_object(
        'collection_name', v_collection.name,
        'collection_slug', v_collection.slug,
        'total_moments', COALESCE((v_summary->>'total_moments')::int, 0),
        'wallet_fmv', COALESCE((v_summary->>'wallet_fmv')::numeric, 0),
        'locked_fmv', COALESCE((v_summary->>'locked_fmv')::numeric, 0),
        'unlocked_fmv', COALESCE((v_summary->>'unlocked_fmv')::numeric, 0),
        'locked_count', COALESCE((v_summary->>'locked_count')::int, 0),
        'unlocked_count', COALESCE((v_summary->>'unlocked_count')::int, 0),
        'cost_basis', COALESCE((v_summary->>'cost_basis')::numeric, 0),
        'pnl', COALESCE((v_summary->>'pnl')::numeric, 0)
      );
    END IF;
  END LOOP;

  -- Pinnacle (separate tables: pinnacle_nft_map.owner, pinnacle_editions, pinnacle_fmv_snapshots)
  SELECT count(*) INTO v_pin_count FROM pinnacle_nft_map WHERE owner = p_wallet;
  IF v_pin_count > 0 THEN
    SELECT COALESCE(SUM(pf.fmv_usd), 0) INTO v_pin_fmv
    FROM pinnacle_nft_map pn
    JOIN pinnacle_editions pe ON pe.external_id = pn.edition_key
    JOIN pinnacle_fmv_snapshots pf ON pf.edition_id = pe.id
    WHERE pn.owner = p_wallet;

    v_total_moments := v_total_moments + v_pin_count;
    v_total_fmv := v_total_fmv + COALESCE(v_pin_fmv, 0);
    v_total_unlocked := v_total_unlocked + v_pin_count;
    v_total_unlocked_fmv := v_total_unlocked_fmv + COALESCE(v_pin_fmv, 0);

    v_results := v_results || jsonb_build_object(
      'collection_name', 'Disney Pinnacle',
      'collection_slug', 'disney_pinnacle',
      'total_moments', v_pin_count,
      'wallet_fmv', ROUND(COALESCE(v_pin_fmv, 0), 2),
      'locked_fmv', 0,
      'unlocked_fmv', ROUND(COALESCE(v_pin_fmv, 0), 2),
      'locked_count', 0,
      'unlocked_count', v_pin_count,
      'cost_basis', 0,
      'pnl', 0
    );
  END IF;

  RETURN jsonb_build_object(
    'wallet', p_wallet,
    'total_moments', v_total_moments,
    'total_fmv', ROUND(v_total_fmv, 2),
    'total_locked_fmv', ROUND(v_total_locked_fmv, 2),
    'total_unlocked_fmv', ROUND(v_total_unlocked_fmv, 2),
    'total_locked', v_total_locked,
    'total_unlocked', v_total_unlocked,
    'total_cost_basis', ROUND(v_total_cost_basis, 2),
    'total_pnl', ROUND(v_total_pnl, 2),
    'collections', v_results,
    'collection_count', jsonb_array_length(v_results)
  );
END;
$function$;
```

NOTE: the loop variant above is reconstructed from the live def pulled 2026-06-06 23:20Z (transcript-verbatim for the Pinnacle block + loop body; cosmetic whitespace may differ). The defective Pinnacle block is preserved exactly.

### E.2 get_cross_collection_deals — dropped overload (int,int), prior body

```sql
CREATE OR REPLACE FUNCTION public.get_cross_collection_deals(p_min_discount integer DEFAULT 15, p_limit integer DEFAULT 6)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_deals JSONB;
BEGIN
  SELECT json_agg(t ORDER BY t.discount DESC)::jsonb INTO v_deals
  FROM (
    SELECT
      cl.flow_id, cl.player_name, cl.set_name, cl.tier, cl.serial_number,
      cl.circulation_count, cl.ask_price, cl.fmv, cl.discount, cl.buy_url,
      cl.thumbnail_url, cl.badge_slugs, cl.collection_id,
      c.slug AS collection_slug, c.name AS collection_name
    FROM cached_listings cl
    JOIN collections c ON c.id = cl.collection_id
    WHERE cl.discount >= p_min_discount
      AND cl.fmv IS NOT NULL
      AND cl.ask_price > 0
    ORDER BY cl.discount DESC
    LIMIT p_limit
  ) t;
  RETURN jsonb_build_object('deals', COALESCE(v_deals, '[]'::jsonb), 'computed_at', NOW());
END;
$function$;
-- If recreated, re-apply: REVOKE ALL ON FUNCTION ... FROM PUBLIC, anon, authenticated;
-- (prior acl was postgres + service_role only)
```

### E.3 get_cross_collection_deals(p_limit int, p_min_discount numeric) — prior pinnacle_deals CTE

Only the `pinnacle_deals` CTE differed (plus no liquidity/freshness gates). Prior CTE:

```sql
  pinnacle_deals AS (
    SELECT
      pcl.character_name as player_name, pcl.set_name, pcl.variant_type as tier,
      NULL::int as serial_number, NULL::int as circulation_count,
      pcl.ask_price, pf.fmv_usd as fmv, pf.fmv_usd as adjusted_fmv,
      ROUND((1 - pcl.ask_price / NULLIF(pf.fmv_usd, 0)) * 100, 1) as discount,
      pf.confidence::text as confidence, 'flowty'::text as source,
      pcl.buy_url, NULL::text as thumbnail_url,
      'Disney Pinnacle'::text as collection_name, 'disney_pinnacle'::text as collection_slug
    FROM pinnacle_cached_listings pcl
    JOIN pinnacle_editions pe ON pe.external_id = pcl.edition_key
    LEFT JOIN pinnacle_fmv_snapshots pf ON pf.edition_id = pe.id
    WHERE pf.fmv_usd > 0
      AND pcl.ask_price > 0
      AND pcl.ask_price < pf.fmv_usd * (1 - p_min_discount / 100.0)
  ),
```

### E.4 holdings_summary — prior Pinnacle-relevant fragments

Diff vs live: re-add the `latest_pinnacle_fmv` CTE + pe/pf joins, and the CASE reads `pf.fmv_usd`:

```sql
  latest_pinnacle_fmv AS (
    SELECT DISTINCT ON (edition_id) edition_id, fmv_usd
    FROM pinnacle_fmv_snapshots
    WHERE fmv_usd IS NOT NULL
    ORDER BY edition_id, computed_at DESC
  ),
  -- in resolved:
      CASE 
        WHEN c.slug = 'disney_pinnacle' THEN pf.fmv_usd
        ELSE uf.fmv_usd
      END AS resolved_fmv_usd,
  -- joins:
    LEFT JOIN pinnacle_editions pe ON pe.edition_key = wmc.edition_key
      AND c.slug = 'disney_pinnacle'
    LEFT JOIN latest_pinnacle_fmv pf ON pf.edition_id = pe.id
```

### E.5 get_wallet_moments_with_fmv — prior base_pinnacle CTE

```sql
  base_pinnacle AS (
    SELECT
      wmc.moment_id,
      pe.edition_key,
      NULL::integer AS serial_number,
      pe.character_name AS player_name,
      pe.set_name,
      pe.variant_type AS tier,
      NULL::integer AS series_number,
      pe.mint_count AS circulation_count,
      NULL::text AS team_name,
      pe.thumbnail_url,
      (pe.character_name || ' — ' || pe.set_name || COALESCE(' (' || pe.variant_type || ')', '')) AS edition_name,
      pfs.fmv_usd,
      pfs.confidence::text AS confidence,
      pfs.floor_usd AS low_ask,
      pfs.algo_version AS fmv_method,
      COALESCE(ma.acquired_date, wmc.acquired_at) AS acquired_at,
      wmc.last_seen_at,
      ma.buy_price, ma.acquisition_method, ma.acquisition_confidence,
      ma.source AS acquisition_source, ma.source_address, ma.loan_principal,
      false AS is_locked
    FROM wallet_moments_cache wmc
    LEFT JOIN pinnacle_nft_map pnm ON pnm.nft_id = wmc.moment_id
    LEFT JOIN pinnacle_editions pe ON pe.edition_key = pnm.edition_key
    LEFT JOIN LATERAL (
      SELECT pfs2.fmv_usd, pfs2.confidence::text AS confidence, 
             pfs2.floor_usd, pfs2.algo_version
      FROM pinnacle_fmv_snapshots pfs2
      WHERE pfs2.edition_id = pe.id
      ORDER BY pfs2.computed_at DESC
      LIMIT 1
    ) pfs ON true
    LEFT JOIN LATERAL (
      SELECT ma2.buy_price, ma2.acquisition_method, ma2.acquisition_confidence,
             ma2.source, ma2.source_address, ma2.acquired_date, ma2.loan_principal
      FROM moment_acquisitions ma2
      WHERE ma2.nft_id = wmc.moment_id AND ma2.wallet = wmc.wallet_address
      ORDER BY ma2.created_at DESC
      LIMIT 1
    ) ma ON true
    WHERE wmc.wallet_address = p_wallet
      AND wmc.collection_id = p_collection_id
      AND p_collection_id = (SELECT u FROM pin_uuid)
  ),
```

(also remove the `NULL::text AS render_id` line from `base_other` when reverting, and restore the prior `wmc.edition_key`→`pe.edition_key` field source).

### E.6 get_moment_detail — prior body (revert for CC item 2)

To revert `audit_20260606_get_moment_detail_pinnacle_renders_additive`: `CREATE OR REPLACE` the body below (drops the `v_renders` decl, the `pinnacle_catalog` renders SELECT, and the `'renders'` key from the pinnacle RETURN). Same signature → SECDEF + grants preserved.

```sql
CREATE OR REPLACE FUNCTION public.get_moment_detail(p_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_resolved      RECORD;
  v_edition       JSONB;
  v_fmv           JSONB;
  v_serial        JSONB := NULL;
  v_recent_sales  JSONB;
  v_similar       JSONB;
BEGIN
  SELECT * INTO v_resolved FROM public.resolve_moment_id(p_id) LIMIT 1;

  IF v_resolved IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found', 'input', p_id);
  END IF;

  IF v_resolved.kind = 'pinnacle_edition' THEN
    SELECT jsonb_build_object(
      'id', pe.id, 'external_id', pe.external_id,
      'character_name', pe.character_name, 'franchise', pe.franchise,
      'set_name', pe.set_name, 'variant_type', pe.variant_type,
      'edition_type', pe.edition_type, 'series_year', pe.series_year,
      'printing', pe.printing, 'mint_count', pe.mint_count,
      'is_serialized', pe.is_serialized, 'is_chaser', pe.is_chaser,
      'thumbnail_url', pe.thumbnail_url, 'studio', pe.studio,
      'materials', pe.materials, 'effects', pe.effects,
      'edition_key', pe.edition_key, 'ask_price', pe.ask_price,
      'ask_source', pe.ask_source, 'collection_slug', 'disney_pinnacle'
    )
    INTO v_edition
    FROM pinnacle_editions pe
    WHERE pe.id = v_resolved.pinnacle_edition_id;

    SELECT jsonb_build_object(
      'fmv_usd', pfs.fmv_usd, 'floor_usd', pfs.floor_usd,
      'wap_usd', pfs.wap_usd, 'confidence', pfs.confidence,
      'sales_count_7d', pfs.sales_count_7d, 'sales_count_30d', pfs.sales_count_30d,
      'days_since_sale', pfs.days_since_sale, 'computed_at', pfs.computed_at,
      'algo_version', pfs.algo_version, 'pinnacle_ask', pfs.pinnacle_ask,
      'flowty_ask', pfs.flowty_ask
    )
    INTO v_fmv
    FROM pinnacle_fmv_snapshots pfs
    WHERE pfs.edition_id = v_resolved.pinnacle_edition_id
    ORDER BY pfs.computed_at DESC LIMIT 1;

    SELECT jsonb_agg(s ORDER BY s.sold_at DESC) INTO v_recent_sales
    FROM (
      SELECT
        ps.serial_number,
        ps.sale_price_usd AS price_usd,
        ps.sold_at,
        ps.source AS marketplace,
        ps.buyer_address,
        ps.seller_address
      FROM pinnacle_sales ps
      WHERE ps.edition_id = v_resolved.pinnacle_edition_id
      ORDER BY ps.sold_at DESC LIMIT 10
    ) s;

    SELECT jsonb_agg(sim) INTO v_similar
    FROM (
      SELECT pe2.id, pe2.character_name, pe2.set_name, pe2.variant_type,
        pe2.edition_type AS tier, pe2.thumbnail_url, pe2.mint_count AS circulation_count,
        (SELECT fmv_usd FROM pinnacle_fmv_snapshots WHERE edition_id = pe2.id
         ORDER BY computed_at DESC LIMIT 1) AS fmv_usd
      FROM pinnacle_editions pe2
      JOIN pinnacle_editions src ON src.id = v_resolved.pinnacle_edition_id
      WHERE pe2.id <> src.id
        AND (pe2.character_name = src.character_name OR pe2.set_name = src.set_name)
      ORDER BY CASE WHEN pe2.character_name = src.character_name THEN 0 ELSE 1 END,
               pe2.minting_date DESC NULLS LAST
      LIMIT 6
    ) sim;

    RETURN jsonb_build_object(
      'ok', true, 'resolved', to_jsonb(v_resolved),
      'edition', v_edition, 'fmv', v_fmv, 'serial_specific', NULL,
      'recent_sales', COALESCE(v_recent_sales, '[]'::jsonb),
      'similar_editions', COALESCE(v_similar, '[]'::jsonb)
    );
  END IF;

  IF v_resolved.edition_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'not_found', 'input', p_id);
  END IF;

  SELECT jsonb_build_object(
    'id', e.id, 'external_id', e.external_id, 'name', e.name,
    'tier', e.tier, 'series', e.series,
    'player_name', e.player_name, 'team_name', e.team_name,
    'set_name', e.set_name, 'set_id_onchain', e.set_id_onchain,
    'play_id_onchain', e.play_id_onchain, 'play_type', e.play_type,
    'play_category', e.play_category, 'game_date', e.game_date,
    'circulation_count', e.circulation_count,
    'thumbnail_url', e.thumbnail_url, 'video_url', e.video_url,
    'collection_slug', v_resolved.collection_slug
  ) INTO v_edition FROM editions e WHERE e.id = v_resolved.edition_id;

  SELECT jsonb_build_object(
    'fmv_usd', fs.fmv_usd, 'floor_price_usd', fs.floor_price_usd,
    'wap_usd', fs.wap_usd, 'confidence', fs.confidence,
    'sales_count_7d', fs.sales_count_7d, 'sales_count_30d', fs.sales_count_30d,
    'days_since_sale', fs.days_since_sale, 'computed_at', fs.computed_at,
    'algo_version', fs.algo_version, 'top_shot_ask', fs.top_shot_ask,
    'flowty_ask', fs.flowty_ask, 'cross_market_ask', fs.cross_market_ask
  )
  INTO v_fmv FROM fmv_snapshots fs
  WHERE fs.edition_id = v_resolved.edition_id
  ORDER BY fs.computed_at DESC LIMIT 1;

  IF v_resolved.kind = 'moment' THEN
    SELECT jsonb_build_object(
      'serial_number', m.serial_number, 'nft_id', m.nft_id,
      'owner_address', m.owner_address, 'is_listed', m.is_listed,
      'list_price', m.list_price, 'listed_at', m.listed_at,
      'last_sale', (
        SELECT jsonb_build_object('price_usd', s.price_usd, 'sold_at', s.sold_at,
                                  'buyer_address', s.buyer_address, 'seller_address', s.seller_address,
                                  'marketplace', s.marketplace)
        FROM sales s WHERE s.moment_id = m.id ORDER BY s.sold_at DESC LIMIT 1
      )
    ) INTO v_serial FROM moments m WHERE m.id = v_resolved.moment_id;
  END IF;

  SELECT jsonb_agg(s ORDER BY sold_at DESC) INTO v_recent_sales
  FROM (SELECT serial_number, price_usd, sold_at, marketplace, buyer_address, seller_address
        FROM sales WHERE edition_id = v_resolved.edition_id
        ORDER BY sold_at DESC LIMIT 10) s;

  SELECT jsonb_agg(sim) INTO v_similar
  FROM (
    SELECT e2.id, e2.player_name, e2.set_name, e2.tier, e2.thumbnail_url, e2.circulation_count,
      (SELECT fmv_usd FROM fmv_snapshots WHERE edition_id = e2.id ORDER BY computed_at DESC LIMIT 1) AS fmv_usd
    FROM editions e2
    JOIN editions src ON src.id = v_resolved.edition_id
    WHERE e2.collection_id = src.collection_id AND e2.id <> src.id
      AND (e2.player_name = src.player_name OR e2.set_name = src.set_name)
    ORDER BY CASE WHEN e2.player_name = src.player_name THEN 0 ELSE 1 END,
             e2.first_minted_at DESC NULLS LAST LIMIT 6) sim;

  RETURN jsonb_build_object(
    'ok', true, 'resolved', to_jsonb(v_resolved),
    'edition', v_edition, 'fmv', v_fmv, 'serial_specific', v_serial,
    'recent_sales', COALESCE(v_recent_sales, '[]'::jsonb),
    'similar_editions', COALESCE(v_similar, '[]'::jsonb)
  );
END;
$function$;
```
