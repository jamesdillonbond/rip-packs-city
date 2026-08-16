-- audit_20260816_price_only_alerts
--
-- A PRICE-ONLY ALERT COULD NOT FIRE. NOT "RARELY" — NEVER.
--
-- "Alert me any time a Damian Lillard Archive moment lists for $0.60 or less"
-- was saved and confirmed as live. It was structurally incapable of firing,
-- because both scanners read `cross_collection_deals_board`, which is a DEALS
-- board by construction. Measured 2026-08-16 on live:
--
--   * topshot_deals_vs_fmv   requires `eo.low_ask >= 5`      <-- $5 floor
--   * the Pinnacle arm       requires `floor_ask >= 1`
--   * the All Day arm        requires `floor_ask >= 1`
--   * every arm requires     `low_ask < fmv_usd` AND confidence IN (HIGH,MEDIUM)
--
--   whole board: 111 rows, cheapest $1.00, ZERO rows at or below $0.60.
--
-- So `max_price 0.60` intersected an empty set. On top of that the FMV gates
-- mean an ask ABOVE FMV, or on an edition with no priced snapshot, can never
-- alert at any price. Trevor: "If all I mention is a price like this, don't
-- assume extra factors like FMV."
--
-- The raw ask universe at that threshold is not empty at all — measured the
-- same day: 2,640 Top Shot + 1,922 All Day + 1 Golazos asks at or below $0.60,
-- cheapest $0.33. The listings were always there; the scanner could not see
-- them.
--
-- ⚠ A SECOND, INDEPENDENT DEFECT BLOCKED THE SAME ALERT, and fixing only the
-- first would have shipped a "fixed" that changed nothing for the one
-- subscription that motivated it. `set_names` was matched with `lower(set_name)
-- = ANY(...)` — EXACT equality — and the saved filter is `Archive` while the
-- real catalogue set is `Archive Set`. So the filter matched zero rows in any
-- pool at any price. Set filters are now CONTAINMENT matches. Measured blast
-- radius: exactly ONE subscription platform-wide uses `set_names` at all, and
-- it currently matches nothing, so no existing alert stream changes.
-- `player_names` stays EXACT on purpose — a player name is a proper noun the
-- concierge resolves against the catalogue, whereas a set name is a phrase
-- people abbreviate ("Archive", "Base", "For the Win").
--
-- WHAT THIS CHANGES
--   1. NEW VIEW `edition_current_ask` — the lowest CURRENT ask per edition from
--      the raw per-collection sources, with NO FMV gate and NO price floor.
--   2. Both scanners gain a PRICE-ONLY pass, taken only when a subscription has
--      `max_price IS NOT NULL AND COALESCE(min_discount,25) = 0`.
--   3. Both scanners match `set_names` by containment instead of equality.
--
-- ⚠ EXISTING SUBSCRIPTIONS ARE UNCHANGED. Any sub with a discount threshold
-- keeps reading exactly the same `tmp_deal_pool` rows in the same order: the
-- price rows are a SEPARATE TAGGED SET (`pool = 'price'`) that only price-only
-- subs can select. That isolation is deliberate — this is a live notification
-- path, and widening what an existing alert fires on is spam.
--
-- ⚠ THE PRICE POOL IS BUILT ONLY WHEN SOMEONE IS USING IT, and bounded by the
-- largest max_price in play. With no price-only subs it costs one aggregate over
-- alert_subscriptions. The dispatcher runs under a 90s statement_timeout and
-- must not regress for a feature nobody has enabled.
--
-- ⚠ THE VIEW CARRIES NO FMV, AND THAT IS A MEASUREMENT, NOT A SHORTCUT. The
-- first draft LEFT JOIN LATERALed the latest `fmv_snapshots` row per edition, so
-- a price alert could still show context. Measured on the Top Shot arm at the
-- TIGHTEST possible cap ($0.60, 2,640 rows): 28,117 ms with the lateral, 320 ms
-- without — 99% of the cost, for a column that is by definition not a condition
-- here. The `computed_at <= now()` partition-pruning trick was already applied
-- and the plan confirmed `Subplans Removed: 1`; it is still 28s, because the
-- cost is 2,640 index probes into fmv_snapshots on a 2 GB disk-IO-throttled
-- instance. A 90s dispatcher shared with every other subscriber cannot pay that.
-- So fmv_usd / confidence / discount_pct / discount_usd are NULL here and the
-- message omits the FMV clause rather than inventing one.
--
-- ⚠ `min_discount = 0` IS THE SENTINEL for "no FMV condition". It is NOT NULL
-- DEFAULT 25 (writing NULL throws 23502), so 0 is the only in-band way to say
-- "no discount required", and it reads naturally. Documented here because the
-- meaning is not obvious from the column name alone.
--
-- ROLLBACK — the primary path is DATA, not code, and it is one statement:
--
--   UPDATE public.alert_subscriptions SET min_discount = 25
--   WHERE max_price IS NOT NULL AND COALESCE(min_discount, 25) = 0;
--
-- With no subscription satisfying the price-only predicate, `v_price_only` is
-- false for every sub, the price pool is never built, and both scanners behave
-- exactly as they did before this migration. The code-level revert (restoring
-- the two prior function bodies) is `git revert <sha>` — the previous
-- definitions are in this file's git history — plus `DROP VIEW IF EXISTS
-- public.edition_current_ask;`.

-- ── 1. Raw current ask per edition, across collections ──────────────────────
--
-- Column list is EXACTLY cross_collection_deals_board's, in the same order, so
-- the scanners can UNION the two pools into one temp table. Verified against
-- information_schema 2026-08-16: 20 columns, positions 1..20.
--
-- ⚠ fmv_usd / confidence / discount_pct / discount_usd are ALWAYS NULL here —
-- see the header for the 28s measurement that decided it. Consumers must not
-- assume a discount exists; `lib/alerts/format.ts` omits the clause.
CREATE OR REPLACE VIEW public.edition_current_ask
WITH (security_invoker = on) AS
  -- NBA Top Shot: edition_offers is the same source topshot_deals_vs_fmv reads
  -- BEFORE it applies the >= $5 floor and the FMV gates. low_ask_serial and
  -- low_ask_nft_id are real columns on that table, so the serial comes free.
  --
  -- ⚠ The canonical-key predicate is a NO-OP TODAY and is here on purpose:
  -- measured 0 of 12,257 rows carry the UUID-pair convention. `editions` stores
  -- the same Top Shot moment under two key conventions, and a UUID-keyed row
  -- would render detail_url as a link that 404s — in a notification, where the
  -- link is the whole payload. Cheap insurance on a write-once surface, not a
  -- load-bearing filter.
  SELECT
    e.external_id::text                                 AS external_id,
    e.name::text                                        AS name,
    e.player_name,
    e.set_name,
    e.tier::text                                        AS tier,
    e.circulation_count,
    NULL::numeric                                       AS fmv_usd,
    NULL::text                                          AS confidence,
    eo.low_ask,
    NULL::numeric                                       AS discount_pct,
    NULL::numeric                                       AS discount_usd,
    eo.updated_at                                       AS ask_updated_at,
    'nba_top_shot'::text                                AS collection_slug,
    'NBA Top Shot'::text                                AS collection_name,
    NULL::text                                          AS render_id,
    '/nba-top-shot/edition/' || replace(e.external_id::text, ':', '%3A') AS detail_url,
    e.thumbnail_url,
    eo.low_ask_serial,
    eo.low_ask_nft_id,
    false                                               AS low_confidence_fmv
  FROM public.edition_offers eo
  JOIN public.editions e
    ON e.external_id::text = eo.external_id
   AND e.collection_id = eo.collection_id
  WHERE eo.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
    AND eo.low_ask > 0
    AND e.external_id::text ~ '^[0-9]+:[0-9]+'

UNION ALL

  -- NFL All Day: the on-chain listing index (open, unexpired, priced rows).
  --
  -- ⚠ NO serial. allday_moment_serials holds 276 rows total and joins only 57
  -- of 4,310 floor rows (1.3%), for ~17% of this arm's buffers — and
  -- cross_collection_deals_board does not carry an All Day serial either, so
  -- populating it here would make the same moment render differently depending
  -- on which pool surfaced it. Both pools feed one message formatter.
  SELECT
    e.external_id::text, e.name::text, e.player_name, e.set_name, e.tier::text, e.circulation_count,
    NULL::numeric, NULL::text, af.floor_ask, NULL::numeric, NULL::numeric,
    af.floor_ask_listed_at,
    'nfl_all_day'::text, 'NFL All Day'::text, NULL::text,
    '/nfl-all-day/edition/' || replace(e.external_id::text, ':', '%3A'),
    e.thumbnail_url, NULL::integer, af.floor_flow_id::text, false
  FROM public.allday_edition_floor_ask af
  JOIN public.editions e
    ON e.id = af.edition_id
   AND e.collection_id = 'dee28451-5d62-409e-a1ad-a83f763ac070'::uuid
  WHERE af.floor_ask > 0

UNION ALL

  -- LaLiga Golazos: same on-chain index, thin market (a few hundred open asks).
  SELECT
    e.external_id::text, e.name::text, e.player_name, e.set_name, e.tier::text, e.circulation_count,
    NULL::numeric, NULL::text, gf.floor_ask, NULL::numeric, NULL::numeric,
    gf.floor_ask_listed_at,
    'laliga_golazos'::text, 'LaLiga Golazos'::text, NULL::text,
    '/laliga-golazos/edition/' || replace(e.external_id::text, ':', '%3A'),
    e.thumbnail_url, NULL::integer, gf.floor_flow_id::text, false
  FROM public.golazos_edition_floor_ask gf
  JOIN public.editions e
    ON e.id = gf.edition_id
   AND e.collection_id = '06248cc4-b85f-47cd-af67-1855d14acd75'::uuid
  WHERE gf.floor_ask > 0

UNION ALL

  -- Disney Pinnacle: per-RENDER ask carried on the catalog row. Pinnacle is
  -- render-keyed, so external_id IS the render_id (both columns are populated,
  -- matching how cross_collection_deals_board shapes its Pinnacle arm).
  SELECT
    pc.render_id::text, ((pc.character_name || ' — ') || pc.set_name)::text,
    pc.character_name, pc.set_name, pc.variant::text, pc.total_minted,
    NULL::numeric, NULL::text, pc.floor_ask, NULL::numeric, NULL::numeric,
    pc.floor_ask_updated_at,
    'disney_pinnacle'::text, 'Disney Pinnacle'::text, pc.render_id,
    '/pinnacle/moment/' || pc.render_id,
    '/api/public/pinnacle-image/' || pc.render_id,
    NULL::integer, NULL::text, false
  FROM public.pinnacle_catalog pc
  WHERE pc.floor_ask > 0;

COMMENT ON VIEW public.edition_current_ask IS
  'Lowest CURRENT ask per edition across collections, with NO FMV gate and NO '
  'price floor — the source for price-only alerts. Column list matches '
  'cross_collection_deals_board exactly so the two can be UNIONed into one '
  'scanner pool. fmv_usd/confidence/discount_pct/discount_usd are ALWAYS NULL: '
  'the FMV lateral measured 28,117ms vs 320ms without, on the cheapest possible '
  'slice, for a column that is not a condition here. Do NOT add a discount or '
  'confidence filter — cross_collection_deals_board already exists for that, '
  'and its $5/$1 price floors plus low_ask < fmv are exactly what made a $0.60 '
  'alert unable to fire (audit_20260816).';

-- Read only by SECURITY DEFINER scanners; no anon/authenticated surface.
REVOKE ALL ON public.edition_current_ask FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.edition_current_ask TO service_role;

-- ── 2. Preview builder ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.build_deal_alerts_for_subscription(p_subscription_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_ts uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_sub public.alert_subscriptions%ROWTYPE;
  v_slugs text[];
  v_deals jsonb;
  v_serial_deals jsonb;
  v_price_only boolean;
BEGIN
  SELECT * INTO v_sub FROM public.alert_subscriptions WHERE id = p_subscription_id;
  IF NOT FOUND OR NOT v_sub.active THEN
    RETURN jsonb_build_object('error','not eligible');
  END IF;

  IF v_sub.collection_ids IS NULL THEN
    v_slugs := ARRAY(SELECT slug FROM public.collections WHERE is_active = true);
  ELSE
    v_slugs := ARRAY(SELECT slug FROM public.collections WHERE id = ANY(v_sub.collection_ids));
  END IF;

  -- "Just a price, no FMV condition."
  v_price_only := (v_sub.max_price IS NOT NULL AND COALESCE(v_sub.min_discount, 25) = 0);

  -- Pass 1 preview: edition-grain deals. Mirrors dispatch_due_deal_alerts
  -- (2026-07-11): team_names + badges filter here too; serial_only skips it.
  IF NOT COALESCE(v_sub.serial_only, false) THEN
    SELECT jsonb_agg(d ORDER BY (d->>'discount_pct')::numeric DESC NULLS LAST,
                                (d->>'low_ask')::numeric ASC)
    INTO v_deals
    FROM (
      SELECT jsonb_build_object(
        'external_id', b.external_id, 'name', b.name,
        'player_name', b.player_name, 'set_name', b.set_name, 'tier', b.tier,
        'collection_slug', b.collection_slug, 'collection_name', b.collection_name,
        'circulation_count', b.circulation_count, 'fmv_usd', b.fmv_usd, 'confidence', b.confidence,
        'low_ask', b.low_ask, 'discount_pct', b.discount_pct, 'discount_usd', b.discount_usd,
        'detail_url', b.detail_url, 'thumbnail_url', b.thumbnail_url, 'ask_updated_at', b.ask_updated_at,
        'price_only', (b.pool = 'price')
      ) AS d
      FROM (
        SELECT * FROM (
          -- The two pools are mutually exclusive per subscription: exactly one
          -- of these branches has a true guard, so the other is a One-Time
          -- Filter. A price-only sub never sees a deals row and vice versa.
          SELECT 'deals'::text AS pool, dl.*
            FROM public.cross_collection_deals_board dl
           WHERE NOT v_price_only AND dl.low_ask > 0 AND dl.fmv_usd > 0
          UNION ALL
          SELECT 'price'::text, pr.*
            FROM public.edition_current_ask pr
           WHERE v_price_only AND pr.low_ask > 0 AND pr.low_ask <= v_sub.max_price
        ) p
        WHERE p.collection_slug = ANY(v_slugs)
          -- A price-only sub has no discount condition at all. Note this is not
          -- the same as ">= 0": discount_pct is NULL in the price pool, and
          -- NULL >= 0 is NULL, which filters the row out. That NULL is the bug.
          AND (v_price_only OR p.discount_pct >= COALESCE(v_sub.min_discount, 25))
          AND (v_sub.max_price IS NULL OR p.low_ask <= v_sub.max_price)
          AND (v_sub.min_price IS NULL OR p.low_ask >= v_sub.min_price)
          AND (v_sub.tiers IS NULL OR p.tier = ANY(v_sub.tiers))
          AND (v_sub.player_names IS NULL OR lower(p.player_name) = ANY(ARRAY(SELECT lower(x) FROM unnest(v_sub.player_names) x)))
          -- CONTAINMENT, not equality -- "Archive" must match "Archive Set".
          AND (v_sub.set_names IS NULL OR EXISTS (
            SELECT 1 FROM unnest(v_sub.set_names) sx
            WHERE lower(p.set_name) LIKE '%' || lower(sx) || '%'
          ))
        ORDER BY p.discount_pct DESC NULLS LAST,
                 (CASE WHEN v_price_only THEN p.low_ask END) ASC
        LIMIT 500
      ) b
      WHERE (v_sub.parallel_names IS NULL OR lower(COALESCE(
              (SELECT NULLIF(be.parallel_name,'') FROM public.badge_editions be
                 WHERE be.external_id = b.external_id AND be.parallel_name NOT IN ('','Standard') LIMIT 1),
              CASE WHEN b.collection_slug = 'disney_pinnacle' THEN b.tier END
            )) = ANY(ARRAY(SELECT lower(x) FROM unnest(v_sub.parallel_names) x)))
        AND (v_sub.team_names IS NULL OR EXISTS (
          SELECT 1 FROM public.editions e
          JOIN public.collections c ON c.id = e.collection_id
          WHERE e.external_id = b.external_id
            AND c.slug = b.collection_slug
            AND lower(e.team_name) = ANY(ARRAY(SELECT lower(x) FROM unnest(v_sub.team_names) x))
        ))
        AND (v_sub.badges IS NULL OR EXISTS (
          SELECT 1 FROM public.editions e
          JOIN public.collections c ON c.id = e.collection_id
          CROSS JOIN LATERAL jsonb_array_elements(public.get_edition_badges_unified(e.id)) AS bj(elem)
          WHERE e.external_id = b.external_id
            AND c.slug = b.collection_slug
            AND regexp_replace(lower(bj.elem->>'title'), '[^a-z0-9]', '', 'g') = ANY(v_sub.badges)
        ))
      ORDER BY b.discount_pct DESC NULLS LAST,
               (CASE WHEN v_price_only THEN b.low_ask END) ASC
      LIMIT 25
    ) x;
  END IF;

  -- Serial-pass preview: special-serial underpriced board (Top Shot only).
  -- Deliberately NOT given a price-only branch: that board is derived from a
  -- serial-vs-edition FMV comparison, so "no FMV condition" has no meaning
  -- there -- every row on it exists because of an FMV gap. A price-only sub
  -- still gets these, bounded by its max_price, as a strict addition.
  IF v_sub.collection_ids IS NULL OR (v_ts = ANY(v_sub.collection_ids)) THEN
    SELECT jsonb_agg(d ORDER BY (d->>'discount_pct')::numeric DESC)
    INTO v_serial_deals
    FROM (
      SELECT jsonb_build_object(
        'external_id', b.external_id, 'player_name', b.player_name, 'set_name', b.set_name, 'tier', b.tier,
        'collection_slug', 'nba-top-shot', 'circulation_count', b.circulation_count,
        'nft_id', b.nft_id, 'serial_number', b.serial_number,
        'kind', CASE WHEN b.serial_number = 1 THEN 'first' ELSE 'perfect' END,
        'ask_usd', b.ask_usd, 'serial_fmv_usd', b.serial_fmv_usd, 'edition_fmv_usd', b.edition_fmv_usd,
        'confidence', b.confidence, 'estimate_quality', b.estimate_quality,
        'discount_pct', b.discount_pct, 'discount_usd', b.discount_usd,
        'listing_url', COALESCE(b.listing_url, 'https://dapper.market/nba/moment/' || b.nft_id),
        'thumbnail_url', b.thumbnail_url
      ) AS d
      FROM public.topshot_underpriced_serials_board b
      WHERE b.estimate_quality = 'tight' AND b.ask_usd > 0
        AND b.discount_pct >= COALESCE(v_sub.min_discount, 25)
        AND (v_sub.max_price IS NULL OR b.ask_usd <= v_sub.max_price)
        AND (v_sub.min_price IS NULL OR b.ask_usd >= v_sub.min_price)
        AND (v_sub.tiers IS NULL OR b.tier = ANY(v_sub.tiers))
        AND (v_sub.player_names IS NULL OR lower(b.player_name) = ANY(ARRAY(SELECT lower(x) FROM unnest(v_sub.player_names) x)))
        AND (v_sub.set_names IS NULL OR EXISTS (
          SELECT 1 FROM unnest(v_sub.set_names) sx
          WHERE lower(b.set_name) LIKE '%' || lower(sx) || '%'
        ))
        AND (v_sub.min_serial IS NULL OR b.serial_number >= v_sub.min_serial)
        AND (v_sub.max_serial IS NULL OR b.serial_number <= v_sub.max_serial)
        AND (NOT COALESCE(v_sub.require_last_mint, false) OR b.serial_number = b.circulation_count)
        AND (v_sub.team_names IS NULL OR EXISTS (
          SELECT 1 FROM public.editions e
          WHERE e.external_id = b.external_id
            AND e.collection_id = v_ts
            AND lower(e.team_name) = ANY(ARRAY(SELECT lower(x) FROM unnest(v_sub.team_names) x))
        ))
        AND (NOT COALESCE(v_sub.require_jersey_serial, false) OR EXISTS (
          SELECT 1 FROM public.editions e
          WHERE e.external_id = b.external_id
            AND e.collection_id = v_ts
            AND e.jersey_number = b.serial_number
        ))
        AND (v_sub.badges IS NULL OR EXISTS (
          SELECT 1
          FROM public.editions e
          CROSS JOIN LATERAL jsonb_array_elements(public.get_edition_badges_unified(e.id)) AS bj(elem)
          WHERE e.external_id = b.external_id
            AND e.collection_id = v_ts
            AND regexp_replace(lower(bj.elem->>'title'), '[^a-z0-9]', '', 'g') = ANY(v_sub.badges)
        ))
      ORDER BY b.discount_pct DESC
      LIMIT 25
    ) y;
  END IF;

  RETURN jsonb_build_object(
    'subscription_id', p_subscription_id, 'owner_key', v_sub.owner_key, 'channels', v_sub.channels,
    'generated_at', now(), 'min_discount', COALESCE(v_sub.min_discount, 25),
    'min_price', v_sub.min_price, 'max_price', v_sub.max_price, 'tiers', v_sub.tiers,
    'player_names', v_sub.player_names, 'set_names', v_sub.set_names, 'collections', v_slugs,
    'team_names', v_sub.team_names, 'badges', v_sub.badges, 'serial_only', COALESCE(v_sub.serial_only, false),
    'price_only', v_price_only,
    'deals_count', COALESCE(jsonb_array_length(v_deals), 0) + COALESCE(jsonb_array_length(v_serial_deals), 0),
    'deals', COALESCE(v_deals, '[]'::jsonb),
    'serial_deals_count', COALESCE(jsonb_array_length(v_serial_deals), 0),
    'serial_deals', COALESCE(v_serial_deals, '[]'::jsonb)
  );
END;
$function$;

-- ── 3. Live dispatcher ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.dispatch_due_deal_alerts(p_max integer DEFAULT 1000)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
 SET statement_timeout TO '90s'
AS $function$
DECLARE
  v_ts uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_sub record;
  v_deal jsonb;
  v_channel text;
  v_target text;
  v_subject text;
  v_bucket text := to_char(now(),'YYYY-MM-DD');
  v_enqueued int := 0;
  v_subs int := 0;
  v_serial_enqueued int := 0;
  v_slugs text[];
  v_deal_pool int := 0;
  v_serial_pool int := 0;
  v_price_pool int := 0;
  v_price_cap numeric;
  v_price_only boolean;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.alert_subscriptions WHERE active = true) THEN
    RETURN jsonb_build_object(
      'subscriptions_scanned', 0,
      'enqueued', 0,
      'serial_enqueued', 0,
      'deal_pool_size', 0,
      'serial_pool_size', 0,
      'price_pool_size', 0,
      'bucket', v_bucket,
      'ran_at', now(),
      'skipped', 'no_active_subscriptions'
    );
  END IF;

  DROP TABLE IF EXISTS tmp_deal_pool;
  CREATE TEMP TABLE tmp_deal_pool ON COMMIT DROP AS
    SELECT 'deals'::text AS pool, b.*
    FROM public.cross_collection_deals_board b
    WHERE b.low_ask > 0 AND b.fmv_usd > 0;
  GET DIAGNOSTICS v_deal_pool = ROW_COUNT;

  -- Price-only rows are appended to the SAME temp table under a different tag,
  -- so pass 1 keeps one loop body and existing subs keep reading pool='deals'
  -- unchanged. Built only when a price-only sub exists, and bounded by the
  -- largest max_price in play -- with none, this costs one aggregate.
  SELECT max(max_price) INTO v_price_cap
  FROM public.alert_subscriptions
  WHERE active = true AND max_price IS NOT NULL AND COALESCE(min_discount, 25) = 0;

  IF v_price_cap IS NOT NULL THEN
    INSERT INTO tmp_deal_pool
    SELECT 'price'::text, a.*
    FROM public.edition_current_ask a
    WHERE a.low_ask > 0 AND a.low_ask <= v_price_cap;
    GET DIAGNOSTICS v_price_pool = ROW_COUNT;
  END IF;

  DROP TABLE IF EXISTS tmp_serial_pool;
  CREATE TEMP TABLE tmp_serial_pool ON COMMIT DROP AS
    SELECT * FROM public.topshot_underpriced_serials_board
    WHERE estimate_quality = 'tight' AND ask_usd > 0;
  GET DIAGNOSTICS v_serial_pool = ROW_COUNT;

  FOR v_sub IN SELECT * FROM public.alert_subscriptions WHERE active = true LOOP
    v_subs := v_subs + 1;

    IF v_sub.collection_ids IS NULL THEN
      v_slugs := ARRAY(SELECT slug FROM public.collections WHERE is_active = true);
    ELSE
      v_slugs := ARRAY(SELECT slug FROM public.collections WHERE id = ANY(v_sub.collection_ids));
    END IF;

    -- "Just a price, no FMV condition."
    v_price_only := (v_sub.max_price IS NOT NULL AND COALESCE(v_sub.min_discount, 25) = 0);

    -- Pass 1: edition-level deals (skipped entirely for serial-only subs).
    -- 2026-07-11: team_names + badges now filter pass 1 too (previously serial-
    -- pass-only, so a team/badge sub got unfiltered edition deals = spam).
    -- Cheap predicates narrow to 500 candidates first so the per-row badge fn
    -- is bounded; team/badge EXISTS then applies before the final LIMIT 25.
    IF NOT COALESCE(v_sub.serial_only, false) THEN
    FOR v_deal IN
      SELECT jsonb_build_object(
        'external_id', b.external_id, 'name', b.name,
        'player_name', b.player_name, 'set_name', b.set_name, 'tier', b.tier,
        'collection_slug', b.collection_slug, 'collection_name', b.collection_name,
        'circulation_count', b.circulation_count, 'fmv_usd', b.fmv_usd, 'confidence', b.confidence,
        'low_ask', b.low_ask, 'discount_pct', b.discount_pct, 'discount_usd', b.discount_usd,
        'detail_url', b.detail_url, 'thumbnail_url', b.thumbnail_url, 'ask_updated_at', b.ask_updated_at,
        'serial_number', b.low_ask_serial, 'nft_id', b.low_ask_nft_id,
        -- Tells the formatter this row carries no FMV BY DESIGN, so it omits
        -- the "below FMV" clause instead of rendering an em-dash for it.
        'price_only', (b.pool = 'price'),
        'parallel', COALESCE(
          (SELECT NULLIF(be.parallel_name,'') FROM public.badge_editions be
             WHERE be.external_id = b.external_id
               AND be.parallel_name IS NOT NULL
               AND be.parallel_name NOT IN ('', 'Standard')
             LIMIT 1),
          (SELECT pc.variant FROM public.pinnacle_catalog pc
             WHERE pc.render_id = b.render_id
               AND pc.variant IS NOT NULL
               AND pc.variant <> 'Standard'
             LIMIT 1)
        )
      ) AS d
      FROM (
        SELECT * FROM tmp_deal_pool p
        WHERE p.pool = CASE WHEN v_price_only THEN 'price' ELSE 'deals' END
          AND p.collection_slug = ANY(v_slugs)
          -- NULL >= 0 is NULL, not true, so a price-only sub must SKIP this
          -- predicate rather than relax it.
          AND (v_price_only OR p.discount_pct >= COALESCE(v_sub.min_discount, 25))
          AND NOT COALESCE(p.low_confidence_fmv, false)
          AND (v_sub.max_price IS NULL OR p.low_ask <= v_sub.max_price)
          AND (v_sub.min_price IS NULL OR p.low_ask >= v_sub.min_price)
          AND (v_sub.tiers IS NULL OR p.tier = ANY(v_sub.tiers))
          AND (v_sub.player_names IS NULL OR lower(p.player_name) = ANY(ARRAY(SELECT lower(x) FROM unnest(v_sub.player_names) x)))
          -- CONTAINMENT, not equality -- "Archive" must match "Archive Set".
          AND (v_sub.set_names IS NULL OR EXISTS (
            SELECT 1 FROM unnest(v_sub.set_names) sx
            WHERE lower(p.set_name) LIKE '%' || lower(sx) || '%'
          ))
        ORDER BY p.discount_pct DESC NULLS LAST,
                 (CASE WHEN v_price_only THEN p.low_ask END) ASC
        LIMIT 500
      ) b
      WHERE (v_sub.parallel_names IS NULL OR lower(COALESCE(
              (SELECT NULLIF(be.parallel_name,'') FROM public.badge_editions be
                 WHERE be.external_id = b.external_id AND be.parallel_name NOT IN ('','Standard') LIMIT 1),
              CASE WHEN b.collection_slug = 'disney_pinnacle' THEN b.tier END
            )) = ANY(ARRAY(SELECT lower(x) FROM unnest(v_sub.parallel_names) x)))
        AND (v_sub.team_names IS NULL OR EXISTS (
          SELECT 1 FROM public.editions e
          JOIN public.collections c ON c.id = e.collection_id
          WHERE e.external_id = b.external_id
            AND c.slug = b.collection_slug
            AND lower(e.team_name) = ANY(ARRAY(SELECT lower(x) FROM unnest(v_sub.team_names) x))
        ))
        AND (v_sub.badges IS NULL OR EXISTS (
          SELECT 1 FROM public.editions e
          JOIN public.collections c ON c.id = e.collection_id
          CROSS JOIN LATERAL jsonb_array_elements(public.get_edition_badges_unified(e.id)) AS bj(elem)
          WHERE e.external_id = b.external_id
            AND c.slug = b.collection_slug
            AND regexp_replace(lower(bj.elem->>'title'), '[^a-z0-9]', '', 'g') = ANY(v_sub.badges)
        ))
      ORDER BY b.discount_pct DESC NULLS LAST,
               (CASE WHEN v_price_only THEN b.low_ask END) ASC
      LIMIT 25
    LOOP
      v_subject := (v_deal->>'collection_slug') || ':' || (v_deal->>'external_id');
      FOREACH v_channel IN ARRAY v_sub.channels LOOP
        SELECT channel_user_id INTO v_target
        FROM public.notification_channels
        WHERE owner_key = v_sub.owner_key AND channel = v_channel
          AND verified = true AND channel_user_id IS NOT NULL
        LIMIT 1;

        IF v_target IS NULL THEN CONTINUE; END IF;

        INSERT INTO public.alert_deliveries
          (owner_key, channel, channel_user_id, alert_kind, subject_key, dedup_bucket, payload)
        VALUES (
          v_sub.owner_key, v_channel, v_target, 'deal',
          v_subject, v_bucket,
          jsonb_build_object('subscription_id', v_sub.id, 'label', v_sub.label, 'deal', v_deal)
        )
        ON CONFLICT (owner_key, channel, alert_kind, subject_key, dedup_bucket) DO NOTHING;

        IF FOUND THEN v_enqueued := v_enqueued + 1; END IF;
      END LOOP;
    END LOOP;
    END IF;

    -- Pass 2: per-serial underpriced deals (unchanged apart from set match).
    IF v_sub.collection_ids IS NULL OR (v_ts = ANY(v_sub.collection_ids)) THEN
      FOR v_deal IN
        SELECT jsonb_build_object(
          'external_id', b.external_id, 'player_name', b.player_name, 'set_name', b.set_name, 'tier', b.tier,
          'collection_slug', 'nba-top-shot', 'circulation_count', b.circulation_count,
          'nft_id', b.nft_id, 'serial_number', b.serial_number,
          'kind', CASE WHEN b.serial_number = 1 THEN 'first' ELSE 'perfect' END,
          'ask_usd', b.ask_usd, 'serial_fmv_usd', b.serial_fmv_usd, 'edition_fmv_usd', b.edition_fmv_usd,
          'confidence', b.confidence, 'estimate_quality', b.estimate_quality,
          'discount_pct', b.discount_pct, 'discount_usd', b.discount_usd,
          'listing_url', COALESCE(b.listing_url, 'https://dapper.market/nba/moment/' || b.nft_id),
          'moment_url', '/moment/' || b.nft_id, 'thumbnail_url', b.thumbnail_url,
          'parallel', (SELECT NULLIF(be.parallel_name,'') FROM public.badge_editions be
                         WHERE be.external_id = b.external_id
                           AND be.parallel_name IS NOT NULL
                           AND be.parallel_name NOT IN ('', 'Standard')
                         LIMIT 1)
        ) AS d
        FROM tmp_serial_pool b
        WHERE b.discount_pct >= COALESCE(v_sub.min_discount, 25)
          AND (v_sub.max_price IS NULL OR b.ask_usd <= v_sub.max_price)
          AND (v_sub.min_price IS NULL OR b.ask_usd >= v_sub.min_price)
          AND (v_sub.tiers IS NULL OR b.tier = ANY(v_sub.tiers))
          AND (v_sub.player_names IS NULL OR lower(b.player_name) = ANY(ARRAY(SELECT lower(x) FROM unnest(v_sub.player_names) x)))
          -- CONTAINMENT, not equality -- "Archive" must match "Archive Set".
          AND (v_sub.set_names IS NULL OR EXISTS (
            SELECT 1 FROM unnest(v_sub.set_names) sx
            WHERE lower(b.set_name) LIKE '%' || lower(sx) || '%'
          ))
          AND (v_sub.parallel_names IS NULL OR EXISTS (
            SELECT 1 FROM public.badge_editions be
            WHERE be.external_id = b.external_id
              AND be.parallel_name NOT IN ('','Standard')
              AND lower(be.parallel_name) = ANY(ARRAY(SELECT lower(x) FROM unnest(v_sub.parallel_names) x))
          ))
          AND (v_sub.min_serial IS NULL OR b.serial_number >= v_sub.min_serial)
          AND (v_sub.max_serial IS NULL OR b.serial_number <= v_sub.max_serial)
          AND (NOT COALESCE(v_sub.require_last_mint, false) OR b.serial_number = b.circulation_count)
          AND (v_sub.team_names IS NULL OR EXISTS (
            SELECT 1 FROM public.editions e
            WHERE e.external_id = b.external_id
              AND e.collection_id = v_ts
              AND lower(e.team_name) = ANY(ARRAY(SELECT lower(x) FROM unnest(v_sub.team_names) x))
          ))
          AND (NOT COALESCE(v_sub.require_jersey_serial, false) OR EXISTS (
            SELECT 1 FROM public.editions e
            WHERE e.external_id = b.external_id
              AND e.collection_id = v_ts
              AND e.jersey_number = b.serial_number
          ))
          AND (NOT COALESCE(v_sub.require_never_sold, false) OR NOT EXISTS (
            SELECT 1 FROM public.sales s WHERE s.nft_id = b.nft_id
          ))
          AND (v_sub.badges IS NULL OR EXISTS (
            SELECT 1
            FROM public.editions e
            CROSS JOIN LATERAL jsonb_array_elements(public.get_edition_badges_unified(e.id)) AS bj(elem)
            WHERE e.external_id = b.external_id
              AND e.collection_id = v_ts
              AND regexp_replace(lower(bj.elem->>'title'), '[^a-z0-9]', '', 'g') = ANY(v_sub.badges)
          ))
        ORDER BY b.discount_pct DESC
        LIMIT 25
      LOOP
        v_subject := (v_deal->>'collection_slug') || ':' || (v_deal->>'external_id')
                     || ':#' || (v_deal->>'serial_number');
        FOREACH v_channel IN ARRAY v_sub.channels LOOP
          SELECT channel_user_id INTO v_target
          FROM public.notification_channels
          WHERE owner_key = v_sub.owner_key AND channel = v_channel
            AND verified = true AND channel_user_id IS NOT NULL
          LIMIT 1;

          IF v_target IS NULL THEN CONTINUE; END IF;

          INSERT INTO public.alert_deliveries
            (owner_key, channel, channel_user_id, alert_kind, subject_key, dedup_bucket, payload)
          VALUES (
            v_sub.owner_key, v_channel, v_target, 'deal',
            v_subject, v_bucket,
            jsonb_build_object('subscription_id', v_sub.id, 'label', v_sub.label, 'deal', v_deal)
          )
          ON CONFLICT (owner_key, channel, alert_kind, subject_key, dedup_bucket) DO NOTHING;

          IF FOUND THEN
            v_enqueued := v_enqueued + 1;
            v_serial_enqueued := v_serial_enqueued + 1;
          END IF;
        END LOOP;
      END LOOP;
    END IF;

    UPDATE public.alert_subscriptions SET last_run_at = now() WHERE id = v_sub.id;
    EXIT WHEN v_enqueued >= p_max;
  END LOOP;

  RETURN jsonb_build_object(
    'subscriptions_scanned', v_subs,
    'enqueued', v_enqueued,
    'serial_enqueued', v_serial_enqueued,
    'deal_pool_size', v_deal_pool,
    'serial_pool_size', v_serial_pool,
    'price_pool_size', v_price_pool,
    'bucket', v_bucket,
    'ran_at', now()
  );
END;
$function$;
