-- audit_20261001 — an alert's team / parallel filters run BEFORE any truncation.
--
-- 🚨 THE DEFECT. Pass 1 of both halves of the deal-alert pipeline
-- (dispatch_due_deal_alerts = the SENDER, build_deal_alerts_for_subscription =
-- the PREVIEW) applied the cheap predicates, took `LIMIT 500` of the WHOLE
-- collection's matching pool in rank order, and only THEN applied team_names,
-- parallel_names and badges. A filtered subscription therefore saw only the
-- slice of its matches that happened to rank inside the collection-wide top 500.
-- Silent in the worst direction: no error, no count, the alert just never fired.
--
-- Measured live 2026-09-30 ~7:20 PM PT: a price-only "Blazers rookie ≤ $0.50"
-- sub (Top Shot, team Portland Trail Blazers, rookie badges) previewed 0 while
-- Greg Brown III "Hustle and Show" sat at $0.25 with an alertable stamp — because
-- 504 alertable Top Shot asks were cheaper and filled the 500 slots first
-- (1,057 alertable Top Shot asks ≤ $0.50). Player and set filters were never
-- affected (they were already inside the capped query).
--
-- THE FIX. team_names + parallel_names move INTO the inner query beside the
-- other cheap predicates (both are indexed single-row lookups: editions
-- (external_id, collection_id) unique; badge_editions (external_id)). The inner
-- `LIMIT 500` is REPLACED by `OFFSET 0`, an optimisation fence, so the one
-- expensive per-row filter — get_edition_badges_unified(), measured ~0.37 ms/row
-- (4,169 rows → 1.57 s, 63.7k buffers) — is evaluated only on survivors, in rank
-- order, and the outer LIMIT 25 stops it at 25 matches.
--
-- ⚠ COST, STATED. With no cap, a sub with `badges` set and NO narrowing filter
-- (team/player/set/parallel) can make the badge function walk its whole pool:
-- worst case today is the full raw-ask pool (21,029 rows ≈ 8 s) per such sub,
-- inside the dispatcher's 90 s statement_timeout. There are ZERO such subs
-- (5 active; all 3 badge subs also carry a team filter, measured 2026-09-30).
-- That trade is deliberate: a bounded-cost filter that drops matches is the
-- defect this migration removes. If badge-only subs appear, the lever is a
-- precomputed badge set per edition, never a cap in front of the filter.
--
-- Built by transforming the bodies in 20260913061500 (verified byte-identical to
-- live prosrc immediately before writing: dispatch md5 e31f5079eadcf3ed02884bdf3ac1bfdc
-- 15,070 chars; preview md5 a7070f8ed5ddc5fda5043793eb8c3eb7 9,484 chars). The
-- ONLY change in each is the pass-1 block (+ one comment in the dispatcher).
--
-- anon-exec: unchanged (dispatch_due_deal_alerts) — CREATE OR REPLACE of an existing fn; ACL preserved, verified anon=false authenticated=false service_role=true.
-- anon-exec: unchanged (build_deal_alerts_for_subscription) — CREATE OR REPLACE of an existing fn; ACL preserved, verified anon=false authenticated=false service_role=true.
--
-- Revert: re-apply the two function bodies from
-- supabase/migrations/20260913061500_audit_20260912_an_alert_is_never_built_from_an_unconfirmed_ask.sql
-- (sections 2 and 3), and re-point both pins in db-invariants-drift-guard.

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
  -- How many of the rows we BUILT are barred from alerting because nobody has
  -- re-confirmed the ask. Reported so "quiet" and "quiet because the upstream
  -- ask lane is behind" are distinguishable from outside (audit_20260912).
  v_deal_pool_unconfirmed int := 0;
  v_price_pool_unconfirmed int := 0;
  v_serial_pool_unconfirmed int := 0;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.alert_subscriptions WHERE active = true) THEN
    RETURN jsonb_build_object(
      'subscriptions_scanned', 0,
      'enqueued', 0,
      'serial_enqueued', 0,
      'deal_pool_size', 0,
      'serial_pool_size', 0,
      'price_pool_size', 0,
      'deal_pool_unconfirmed', 0,
      'serial_pool_unconfirmed', 0,
      'price_pool_unconfirmed', 0,
      'bucket', v_bucket,
      'ran_at', now(),
      'skipped', 'no_active_subscriptions'
    );
  END IF;

  -- ⚠ `alertable` is computed ONCE here rather than in each per-subscription
  -- WHERE: the price pool can be thousands of rows and the loop runs per sub, and
  -- it also makes the unconfirmed counts exact rather than a second scan of a
  -- view whose Top Shot leg is the expensive one.
  DROP TABLE IF EXISTS tmp_deal_pool;
  CREATE TEMP TABLE tmp_deal_pool ON COMMIT DROP AS
    SELECT 'deals'::text AS pool, b.*,
           public.ask_is_alertable(b.collection_slug, b.ask_updated_at) AS alertable
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
    SELECT 'price'::text, a.*,
           public.ask_is_alertable(a.collection_slug, a.ask_updated_at)
    FROM public.edition_current_ask a
    WHERE a.low_ask > 0 AND a.low_ask <= v_price_cap;
    GET DIAGNOSTICS v_price_pool = ROW_COUNT;
  END IF;

  SELECT count(*) FILTER (WHERE pool = 'deals' AND NOT alertable),
         count(*) FILTER (WHERE pool = 'price' AND NOT alertable)
    INTO v_deal_pool_unconfirmed, v_price_pool_unconfirmed
  FROM tmp_deal_pool;

  DROP TABLE IF EXISTS tmp_serial_pool;
  CREATE TEMP TABLE tmp_serial_pool ON COMMIT DROP AS
    SELECT s.*,
           public.ask_is_alertable('nba_top_shot', s.last_seen_at) AS alertable
    FROM public.topshot_underpriced_serials_board s
    WHERE s.estimate_quality = 'tight' AND s.ask_usd > 0;
  GET DIAGNOSTICS v_serial_pool = ROW_COUNT;

  SELECT count(*) FILTER (WHERE NOT alertable)
    INTO v_serial_pool_unconfirmed
  FROM tmp_serial_pool;

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
    -- audit_20261001: every filter but badges runs before any truncation, and
    -- badges (the one per-row function) runs last, lazily, under LIMIT 25.
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
          -- An ask nobody has re-confirmed inside ASK_STALE_HOURS does not get
          -- to wake a human. This is the ONLY predicate standing between the
          -- 2026-09-09 $0.50 Lillard ask and its fourth consecutive nightly
          -- delivery on 09-13, by which time the floor was $1.03
          -- (audit_20260912).
          AND p.alertable
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
          -- audit_20261001: team + parallel filter HERE, before anything can
          -- truncate. Until now they ran AFTER a LIMIT 500 over the cheap
          -- predicates, so a team sub silently lost every match ranked below the
          -- 500th row of the WHOLE collection: live, a $0.25 Blazers rookie ask
          -- sat behind 504 cheaper Top Shot asks and was never sent.
          AND (v_sub.parallel_names IS NULL OR lower(COALESCE(
                (SELECT NULLIF(be.parallel_name,'') FROM public.badge_editions be
                   WHERE be.external_id = p.external_id AND be.parallel_name NOT IN ('','Standard') LIMIT 1),
                CASE WHEN p.collection_slug = 'disney_pinnacle' THEN p.tier END
              )) = ANY(ARRAY(SELECT lower(x) FROM unnest(v_sub.parallel_names) x)))
          AND (v_sub.team_names IS NULL OR EXISTS (
            SELECT 1 FROM public.editions e
            JOIN public.collections c ON c.id = e.collection_id
            WHERE e.external_id = p.external_id
              AND c.slug = p.collection_slug
              AND lower(e.team_name) = ANY(ARRAY(SELECT lower(x) FROM unnest(v_sub.team_names) x))
          ))
        ORDER BY p.discount_pct DESC NULLS LAST,
                 (CASE WHEN v_price_only THEN p.low_ask END) ASC
        -- ⚠ OFFSET 0 is a FENCE, not a no-op: it stops the planner pushing the
        -- per-row badge function below into this scan, so badges are evaluated
        -- only on rows that survived every cheaper filter, in rank order, and
        -- the outer LIMIT 25 can stop as soon as 25 match. There is NO cap here
        -- on purpose -- a cap ahead of a filter is the defect being removed.
        OFFSET 0
      ) b
      WHERE (v_sub.badges IS NULL OR EXISTS (
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
        WHERE b.alertable
          AND b.discount_pct >= COALESCE(v_sub.min_discount, 25)
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
    'deal_pool_unconfirmed', v_deal_pool_unconfirmed,
    'serial_pool_unconfirmed', v_serial_pool_unconfirmed,
    'price_pool_unconfirmed', v_price_pool_unconfirmed,
    'bucket', v_bucket,
    'ran_at', now()
  );
END;
$function$;

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
          -- Never preview an ask the sender is barred from sending
          -- (audit_20260912).
          AND public.ask_is_alertable(p.collection_slug, p.ask_updated_at)
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
          -- audit_20261001: team + parallel filter HERE, before anything can
          -- truncate. Until now they ran AFTER a LIMIT 500 over the cheap
          -- predicates, so a team sub silently lost every match ranked below the
          -- 500th row of the WHOLE collection: live, a $0.25 Blazers rookie ask
          -- sat behind 504 cheaper Top Shot asks and was never sent.
          AND (v_sub.parallel_names IS NULL OR lower(COALESCE(
                (SELECT NULLIF(be.parallel_name,'') FROM public.badge_editions be
                   WHERE be.external_id = p.external_id AND be.parallel_name NOT IN ('','Standard') LIMIT 1),
                CASE WHEN p.collection_slug = 'disney_pinnacle' THEN p.tier END
              )) = ANY(ARRAY(SELECT lower(x) FROM unnest(v_sub.parallel_names) x)))
          AND (v_sub.team_names IS NULL OR EXISTS (
            SELECT 1 FROM public.editions e
            JOIN public.collections c ON c.id = e.collection_id
            WHERE e.external_id = p.external_id
              AND c.slug = p.collection_slug
              AND lower(e.team_name) = ANY(ARRAY(SELECT lower(x) FROM unnest(v_sub.team_names) x))
          ))
        ORDER BY p.discount_pct DESC NULLS LAST,
                 (CASE WHEN v_price_only THEN p.low_ask END) ASC
        -- ⚠ OFFSET 0 is a FENCE, not a no-op: it stops the planner pushing the
        -- per-row badge function below into this scan, so badges are evaluated
        -- only on rows that survived every cheaper filter, in rank order, and
        -- the outer LIMIT 25 can stop as soon as 25 match. There is NO cap here
        -- on purpose -- a cap ahead of a filter is the defect being removed.
        OFFSET 0
      ) b
      WHERE (v_sub.badges IS NULL OR EXISTS (
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
        -- ⚠ The LONG-FORM slug on purpose: this board's payload says
        -- 'nba-top-shot' (hyphens) and the gate's exempt-list is long-form, so
        -- passing the payload's spelling would gate correctly by accident here
        -- and read as an endorsement of mixing the two conventions.
        AND public.ask_is_alertable('nba_top_shot', b.last_seen_at)
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
