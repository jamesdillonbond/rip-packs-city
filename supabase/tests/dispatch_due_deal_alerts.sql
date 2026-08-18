-- DB invariant: public.dispatch_due_deal_alerts(integer) → jsonb — the SENDING
-- half of the deal-alert pipeline (its preview sibling is pinned in
-- supabase/tests/build_deal_alerts_for_subscription.sql). This is the function
-- that writes rows a human then receives, so it is the one where being wrong is
-- expensive in both directions: a miss is silent, and a duplicate is spam.
--
-- ⚠ WHY THIS ONE, AND WHY AN ALERT IS THE WORST THING TO LEAVE UNPINNED. An
-- alert's failure mode is SILENCE, so it is unfalsifiable from outside: nobody
-- can tell "no deals matched" from "the scanner could not see them". That is not
-- hypothetical here — the 2026-08-16 migration this DDL comes from exists
-- because a saved, confirmed-live "$0.60 or less" alert was structurally
-- INCAPABLE of firing for weeks: both passes read cross_collection_deals_board,
-- which carries a $5 floor and FMV gates, so the price intersected an empty set
-- while 2,640 Top Shot asks at or below $0.60 sat in the raw ask table.
--
-- Pinned here:
--   1. PRICE-POOL CONSTRUCTION IS CONDITIONAL AND BOUNDED. The raw-ask pool is
--      built only when some active sub is price-only (max_price set AND
--      min_discount = 0), and only up to the largest such max_price. With no
--      price-only sub, price_pool_size is 0 and no raw ask can reach anyone.
--   2. A PRICE-ONLY SUB ACTUALLY RECEIVES ONE — the defect the migration fixed.
--   3. AN ORDINARY DISCOUNT SUB DOES NOT. The pools are mutually exclusive per
--      subscription; a price row must not leak into a deals subscription.
--   4. DEDUPE IS REAL AND `enqueued` COUNTS ONLY NEW ROWS. A second run in the
--      same dedup_bucket enqueues 0 — the ON CONFLICT DO NOTHING makes FOUND
--      false, so the counter must not advance. ⚠ A counter that advanced anyway
--      would report a healthy send on a run that delivered nothing new, which is
--      the `rows_written`-as-null-instrument shape this repo already documents.
--   5. NO VERIFIED CHANNEL ⇒ NO DELIVERY. An unverified row is skipped, not
--      written with a null target.
--   6. NO ACTIVE SUBSCRIPTIONS ⇒ skipped: 'no_active_subscriptions', a stated
--      reason rather than a silent zero that reads as "nothing matched".
--
-- ⚠ NOT pinned, recorded so nobody adds a vacuous version: `bucket` is
-- to_char(now(),'YYYY-MM-DD'), so a same-transaction second call always lands in
-- the same bucket. That makes case 4 airtight HERE and says nothing about the
-- day rollover, which no rolled-back test can reach.
--
-- ⚠ ONE MUTATION DELIBERATELY SURVIVES, AND THE REASON IS A PROPERTY OF THE
-- FUNCTION RATHER THAN A HOLE IN THIS FILE. Replacing `IF v_price_cap IS NOT
-- NULL THEN` with `IF true THEN` changes nothing observable: the INSERT it
-- guards filters on `a.low_ask <= v_price_cap`, and `<= NULL` is NULL, so the
-- pool comes back empty either way. The `IF` is belt-and-braces over the NULL
-- comparison — it saves a scan, it does not decide the outcome. Documented
-- rather than chased with a contrived assertion, because the load-bearing
-- predicate is the one selecting v_price_cap, and THAT mutation is killed
-- (case 1). Do not "fix" this by asserting on the IF.

-- Mutation-verified 2026-08-17. Each of these fails a NAMED assertion:
--   • price-cap predicate drops `COALESCE(min_discount, 25) = 0`   → case 1
--   • pass 1 reads both pools instead of `pool = CASE WHEN …`      → case 3
--   • `IF v_target IS NULL THEN CONTINUE` removed                  → case 5
--   • `IF FOUND THEN v_enqueued := …` counts matches not writes    → case 4
--   • the no-active-subscriptions early return removed             → case 6
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260816161500_audit_20260816_price_only_alerts.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from
-- it. Verified 2026-08-17 that the migration's body is byte-identical to the
-- LIVE prosrc (md5 24ab9e7953c0005b10e987cbea62307e, 13,203 chars).
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE collections (id uuid PRIMARY KEY, slug text, is_active boolean);

CREATE TABLE editions (
  id            uuid PRIMARY KEY,
  collection_id uuid,
  external_id   text,
  player_name   text,
  set_name      text,
  team_name     text,
  jersey_number integer
);

CREATE TABLE badge_editions (external_id text, parallel_name text);

CREATE TABLE alert_subscriptions (
  id                     uuid PRIMARY KEY,
  owner_key              text,
  label                  text,
  channels               text[],
  collection_ids         uuid[],
  min_discount           numeric,
  max_price              numeric,
  tiers                  text[],
  cadence                text,
  active                 boolean,
  created_at             timestamptz,
  updated_at             timestamptz,
  last_run_at            timestamptz,
  player_names           text[],
  set_names              text[],
  team_names             text[],
  min_price              numeric,
  min_serial             integer,
  max_serial             integer,
  require_jersey_serial  boolean,
  require_last_mint      boolean,
  require_never_sold     boolean,
  require_low_ask        boolean,
  badges                 text[],
  parallel_names         text[],
  serial_only            boolean
);

CREATE TABLE notification_channels (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_key            text,
  channel              text,
  channel_user_id      text,
  channel_username     text,
  verified             boolean,
  link_code            text,
  link_code_expires_at timestamptz,
  created_at           timestamptz,
  verified_at          timestamptz,
  last_used_at         timestamptz
);

CREATE TABLE alert_deliveries (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_key       text,
  channel         text,
  channel_user_id text,
  alert_kind      text,
  subject_key     text,
  dedup_bucket    text,
  payload         jsonb,
  status          text,
  attempts        integer,
  created_at      timestamptz DEFAULT now(),
  sent_at         timestamptz,
  last_error      text
);

-- ⚠ The ON CONFLICT target. Without this unique constraint the INSERT raises
-- 42P10 rather than de-duplicating, so case 4 would fail for the wrong reason —
-- and a version of this file that dropped the constraint to "make it pass"
-- would silently stop testing dedupe at all.
CREATE UNIQUE INDEX alert_deliveries_dedup
  ON alert_deliveries (owner_key, channel, alert_kind, subject_key, dedup_bucket);

-- The two alert pools plus the serial board, same shapes as the live catalog
-- (2026-08-17). Identical column lists are what make the UNION-by-INSERT legal.
CREATE TABLE cross_collection_deals_board (
  external_id text, name text, player_name text, set_name text, tier text,
  circulation_count integer, fmv_usd numeric, confidence text, low_ask numeric,
  discount_pct numeric, discount_usd numeric, ask_updated_at timestamptz,
  collection_slug text, collection_name text, render_id text, detail_url text,
  thumbnail_url text, low_ask_serial integer, low_ask_nft_id text,
  low_confidence_fmv boolean
);

CREATE TABLE edition_current_ask (
  external_id text, name text, player_name text, set_name text, tier text,
  circulation_count integer, fmv_usd numeric, confidence text, low_ask numeric,
  discount_pct numeric, discount_usd numeric, ask_updated_at timestamptz,
  collection_slug text, collection_name text, render_id text, detail_url text,
  thumbnail_url text, low_ask_serial integer, low_ask_nft_id text,
  low_confidence_fmv boolean
);

CREATE TABLE topshot_underpriced_serials_board (
  edition_id uuid, edition_key text, external_id text, player_name text,
  set_name text, tier text, circulation_count integer, thumbnail_url text,
  nft_id text, serial_number integer, ask_usd numeric, listing_resource_id text,
  listing_url text, listed_at timestamptz, last_seen_at timestamptz,
  edition_fmv_usd numeric, confidence text, serial_bucket text,
  serial_fmv_usd numeric, serial_multiplier numeric, discount_usd numeric,
  discount_pct numeric, estimate_quality text
);

-- Minimal shape for the Pinnacle parallel lookup in pass 1. Not exercised by any
-- case below (every fixture row is Top Shot with a NULL render_id), but plpgsql
-- plans the whole statement, so the relation must exist.
CREATE TABLE pinnacle_catalog (render_id text, variant text);

-- Only reached through `require_never_sold`, which no case below sets — but
-- plpgsql plans the whole statement, so it must exist.
CREATE TABLE sales (nft_id text);

-- Dependency stub: the badge branch is guarded by `badges IS NULL`, but plpgsql
-- PLANS the whole statement, so the function must EXIST or every case fails on
-- planning rather than on its invariant. No case below sets `badges`.
CREATE OR REPLACE FUNCTION public.get_edition_badges_unified(p_edition_id uuid)
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$ SELECT '[]'::jsonb $$;

-- >>> BEGIN verbatim dispatch_due_deal_alerts (keep byte-identical to the migration) >>>
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
-- <<< END verbatim dispatch_due_deal_alerts <<<

-- ── fixture data ───────────────────────────────────────────────────────────
INSERT INTO collections (id, slug, is_active) VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'nba_top_shot', true);

INSERT INTO cross_collection_deals_board
  (external_id, name, player_name, set_name, tier, circulation_count, fmv_usd,
   confidence, low_ask, discount_pct, discount_usd, ask_updated_at,
   collection_slug, collection_name, render_id, detail_url, thumbnail_url,
   low_ask_serial, low_ask_nft_id, low_confidence_fmv)
VALUES
  ('73:2785', 'Lillard Deal', 'Damian Lillard', 'Archive Set', 'COMMON', 12000,
   40.00, 'HIGH', 20.00, 50.0, 20.00, now(),
   'nba_top_shot', 'NBA Top Shot', NULL, '/nba-top-shot/edition/73%3A2785', NULL,
   NULL, NULL, false),
  -- ⚠ A SECOND deals row, priced UNDER the price-only sub's cap. Without it the
  -- pool guard is untestable: the first row is $20 and the price-only cap is
  -- $0.60, so the PRICE FILTER excludes it either way and a mutation dropping
  -- `pool = CASE WHEN v_price_only …` survives. This row is cheap enough to pass
  -- that filter, so the only thing keeping it away from a price-only subscriber
  -- is the pool guard itself. (Verified: the mutation is killed with this row
  -- present and survives without it.)
  ('73:4242', 'Cheap Deal', 'Damian Lillard', 'Archive Set', 'COMMON', 12000,
   2.00, 'HIGH', 0.50, 75.0, 1.50, now(),
   'nba_top_shot', 'NBA Top Shot', NULL, '/nba-top-shot/edition/73%3A4242', NULL,
   NULL, NULL, false);

-- The raw ask a price-only alert exists for: cheap, and with no fmv at all, so
-- it can never appear on the deals board.
INSERT INTO edition_current_ask
  (external_id, name, player_name, set_name, tier, circulation_count, fmv_usd,
   confidence, low_ask, discount_pct, discount_usd, ask_updated_at,
   collection_slug, collection_name, render_id, detail_url, thumbnail_url,
   low_ask_serial, low_ask_nft_id, low_confidence_fmv)
VALUES
  ('73:9001', 'Cheap Lillard', 'Damian Lillard', 'Archive Set', 'COMMON', 12000,
   NULL, NULL, 0.33, NULL, NULL, now(),
   'nba_top_shot', 'NBA Top Shot', NULL, '/nba-top-shot/edition/73%3A9001', NULL,
   NULL, NULL, false);

INSERT INTO notification_channels (owner_key, channel, channel_user_id, verified)
VALUES ('owner-price', 'email', 'price@example.test', true),
       ('owner-deals', 'email', 'deals@example.test', true),
       ('owner-unver', 'email', 'unver@example.test', false);

-- ── (6) no active subscriptions must SAY so ────────────────────────────────
DO $$
DECLARE r jsonb;
BEGIN
  r := public.dispatch_due_deal_alerts();
  PERFORM _assert_eq((r->>'skipped'), 'no_active_subscriptions',
    'with nothing active the run states its reason rather than returning a bare zero');
  PERFORM _assert_eq((r->>'enqueued'), '0', 'and enqueues nothing');
  RAISE NOTICE '✓ dispatch_due_deal_alerts: an empty run names its reason';
END $$;

-- ── (1) the price pool is CONDITIONAL ──────────────────────────────────────
-- One ordinary discount subscription, no price-only sub anywhere.
--
-- ⚠ IT CARRIES A max_price, AND THAT IS THE WHOLE POINT OF THE FIXTURE. "At
-- least 25% off AND under $50" is an ordinary subscription, and it is the only
-- shape that can tell the real predicate from a plausible wrong one: the raw
-- pool is gated on max_price IS NOT NULL **AND min_discount = 0**, so a version
-- that forgot the second clause would build the pool for THIS sub and could
-- deliver an ask with no FMV to someone who asked for a discount.
--
-- ⚠ The first version of this file used a max_price-less sub here and BOTH
-- mutations survived — dropping the min_discount clause changed nothing,
-- because the only row carrying a max_price was the price-only one. That is the
-- "fixture cannot distinguish the two implementations" vacuity shape, and it is
-- invisible until the mutation is actually run.
INSERT INTO alert_subscriptions (id, owner_key, channels, collection_ids, min_discount, max_price, active, serial_only)
VALUES ('22222222-2222-2222-2222-222222222222', 'owner-deals', ARRAY['email'],
        ARRAY['95f28a17-224a-4025-96ad-adf8a4c63bfd']::uuid[], 25, 50.00, true, false);

DO $$
DECLARE r jsonb;
BEGIN
  r := public.dispatch_due_deal_alerts();
  PERFORM _assert_eq((r->>'price_pool_size'), '0',
    'with no price-only subscription the raw-ask pool is never built');
  PERFORM _assert_eq((r->>'deal_pool_size'), '2', 'the deals pool still is');
  PERFORM _assert_eq((r->>'enqueued'), '2', 'the discount sub gets both deals-board rows');
  -- (3) exclusion: the raw ask must not reach a deals subscription at all.
  PERFORM _assert(NOT EXISTS (
    SELECT 1 FROM alert_deliveries WHERE subject_key LIKE '%73:9001'),
    'a raw ask must never be delivered to an ordinary discount subscription');
  PERFORM _assert_eq((SELECT count(*)::text FROM alert_deliveries), '2', 'exactly two rows written');
  PERFORM _assert(EXISTS (SELECT 1 FROM alert_subscriptions
                          WHERE id = '22222222-2222-2222-2222-222222222222' AND last_run_at IS NOT NULL),
    'the subscription is stamped as run');

  -- (4) DEDUPE. A second run in the same bucket must enqueue NOTHING, and the
  -- counter must not advance -- an `enqueued` that counted matches rather than
  -- writes would report a healthy send on a run that delivered nothing.
  r := public.dispatch_due_deal_alerts();
  PERFORM _assert_eq((r->>'enqueued'), '0', 'a second run in the same bucket enqueues nothing');
  PERFORM _assert_eq((SELECT count(*)::text FROM alert_deliveries), '2', 'and writes no further rows');

  RAISE NOTICE '✓ dispatch_due_deal_alerts: pool gating, exclusion and dedupe';
END $$;

-- ── (2) a price-only subscription receives the raw ask ─────────────────────
INSERT INTO alert_subscriptions (id, owner_key, channels, collection_ids, min_discount, max_price, active, serial_only)
VALUES ('11111111-1111-1111-1111-111111111111', 'owner-price', ARRAY['email'],
        ARRAY['95f28a17-224a-4025-96ad-adf8a4c63bfd']::uuid[], 0, 0.60, true, false);

DO $$
DECLARE r jsonb;
BEGIN
  r := public.dispatch_due_deal_alerts();
  PERFORM _assert_eq((r->>'price_pool_size'), '1',
    'a price-only subscription makes the raw-ask pool get built');
  PERFORM _assert(EXISTS (
    SELECT 1 FROM alert_deliveries
    WHERE owner_key = 'owner-price' AND subject_key = 'nba_top_shot:73:9001'),
    'and the $0.33 ask is actually delivered -- the defect the migration fixed');
  -- ⚠ Assert on the CHEAP deals row, not the $20 one. The $20 row is excluded by
  -- the sub's own max_price whatever the pool guard does, so asserting on it
  -- would pass against a mutation that unioned both pools. `73:4242` is $0.50,
  -- inside the $0.60 cap, so ONLY the pool guard keeps it away.
  PERFORM _assert(NOT EXISTS (
    SELECT 1 FROM alert_deliveries
    WHERE owner_key = 'owner-price' AND subject_key = 'nba_top_shot:73:4242'),
    'a deals-board row does NOT reach a price-only subscriber even when it is under their cap');
  RAISE NOTICE '✓ dispatch_due_deal_alerts: a price-only subscription receives a raw ask';
END $$;

-- ── (5) an unverified channel produces no delivery ─────────────────────────
INSERT INTO alert_subscriptions (id, owner_key, channels, collection_ids, min_discount, active, serial_only)
VALUES ('33333333-3333-3333-3333-333333333333', 'owner-unver', ARRAY['email'],
        ARRAY['95f28a17-224a-4025-96ad-adf8a4c63bfd']::uuid[], 25, true, false);

DO $$
BEGIN
  PERFORM public.dispatch_due_deal_alerts();
  PERFORM _assert(NOT EXISTS (SELECT 1 FROM alert_deliveries WHERE owner_key = 'owner-unver'),
    'an unverified channel is skipped, not written with a null target');
  -- Positive control: the same subscription shape DOES deliver once verified,
  -- so the case above is a real gate and not a broken fixture.
  UPDATE notification_channels SET verified = true WHERE owner_key = 'owner-unver';
  PERFORM public.dispatch_due_deal_alerts();
  PERFORM _assert(EXISTS (SELECT 1 FROM alert_deliveries WHERE owner_key = 'owner-unver'),
    'and delivers once the channel is verified');
  RAISE NOTICE '✓ dispatch_due_deal_alerts: verification gates delivery';
END $$;

ROLLBACK;
