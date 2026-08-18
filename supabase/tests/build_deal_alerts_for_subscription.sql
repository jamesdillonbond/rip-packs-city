-- DB invariant: public.build_deal_alerts_for_subscription(uuid) → jsonb — the
-- PREVIEW half of the deal-alert pipeline (the dispatcher calls the same two
-- pools). Pins the two defects the 2026-08-16 migration fixed, both of which
-- made a saved, "live"-looking alert structurally incapable of firing:
--
--   1. PRICE-ONLY ROUTING. `max_price` set with `min_discount = 0` means "just a
--      price, no FMV condition". Before the fix both passes read
--      cross_collection_deals_board, which is a DEALS board by construction
--      ($5 floor, low_ask < fmv, confidence IN (HIGH,MEDIUM)) — so a $0.60 alert
--      intersected an empty set while 2,640 Top Shot asks at or below $0.60
--      existed. A price-only sub must read edition_current_ask, the raw ask
--      universe, and must see a row whose fmv_usd/confidence are NULL.
--   2. SET-NAME CONTAINMENT. `set_names` matched with `lower(set_name) = ANY(…)`
--      — exact equality — so the saved filter "Archive" never matched the real
--      catalogue set "Archive Set". Set filters are containment now.
--      ⚠ `player_names` stays EXACT, deliberately, and that asymmetry is pinned
--      here too: a fix that "tidied" both to LIKE would pass a test that only
--      checked the set case, and would silently widen every player alert.
--
-- Also pinned: the two pools are MUTUALLY EXCLUSIVE per subscription (a
-- price-only sub sees no deals-board row and vice versa), an inactive or
-- unknown subscription returns {"error":"not eligible"} rather than an empty
-- result set, and deals_count is the SUM of both passes.
--
-- ⚠ NOT pinned here, and recorded so nobody adds a vacuous version: the UNION
-- ALL between the two pools requires their column lists to be IDENTICAL in the
-- same order (verified live 2026-08-17 — both are the same 20 columns). This
-- file BUILDS both fixtures, so asserting they match would only assert that the
-- fixture matches itself. That check belongs against the live catalog, not here.
--
-- The function DDL below is a VERBATIM copy of the committed migration
-- (supabase/migrations/20260816161500_audit_20260816_price_only_alerts.sql);
-- __tests__/db-invariants-drift-guard.test.ts fails CI if this copy drifts from
-- it. Verified 2026-08-17 that the migration's body is byte-identical to the
-- LIVE prosrc (md5 f17cfe05e4ab8d88e05fd56f7ce021c8, 8,943 chars) — a pin
-- against a stale migration would pin something production does not run.
--
-- Runs inside a rolled-back transaction so it leaves no residue.

BEGIN;

CREATE TABLE collections (id uuid PRIMARY KEY, slug text, is_active boolean);

CREATE TABLE editions (
  id              uuid PRIMARY KEY,
  collection_id   uuid,
  external_id     text,
  player_name     text,
  set_name        text,
  team_name       text,
  jersey_number   integer
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

-- The two alert pools. In production these are VIEWS with identical column
-- lists (that is what makes the UNION ALL legal); here they are tables of the
-- same shape and order, taken from the live catalog on 2026-08-17.
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

-- Dependency stub. The badge branches are guarded by `v_sub.badges IS NULL`,
-- but plpgsql PLANS the whole statement on first execution, so the function must
-- EXIST or every case fails on planning rather than on its invariant. Returning
-- an empty array keeps it inert; no case below sets `badges`.
CREATE OR REPLACE FUNCTION public.get_edition_badges_unified(p_edition_id uuid)
RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$ SELECT '[]'::jsonb $$;

-- >>> BEGIN verbatim build_deal_alerts_for_subscription (keep byte-identical to the migration) >>>
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
-- <<< END verbatim build_deal_alerts_for_subscription <<<

-- ── fixture data ───────────────────────────────────────────────────────────
INSERT INTO collections (id, slug, is_active) VALUES
  ('95f28a17-224a-4025-96ad-adf8a4c63bfd', 'nba_top_shot', true);

-- A DEALS-board row: a real discount, well above the board's $5 floor.
INSERT INTO cross_collection_deals_board
  (external_id, name, player_name, set_name, tier, circulation_count, fmv_usd,
   confidence, low_ask, discount_pct, discount_usd, ask_updated_at,
   collection_slug, collection_name, render_id, detail_url, thumbnail_url,
   low_ask_serial, low_ask_nft_id, low_confidence_fmv)
VALUES
  ('73:2785', 'Lillard Deal', 'Damian Lillard', 'Archive Set', 'COMMON', 12000,
   40.00, 'HIGH', 20.00, 50.0, 20.00, now(),
   'nba_top_shot', 'NBA Top Shot', NULL, '/nba-top-shot/edition/73%3A2785', NULL,
   NULL, NULL, false);

-- A RAW-ASK row: the shape the price-only alert exists for — cheap, and with NO
-- fmv/confidence at all, so it can never appear on the deals board.
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

-- Subscriptions. Every one is Top-Shot-scoped and serial_only = false unless
-- stated; `badges` stays NULL throughout so the stub above never has to matter.
INSERT INTO alert_subscriptions (id, owner_key, channels, collection_ids, min_discount, max_price, active, serial_only)
VALUES
  -- (1) PRICE-ONLY: a price and no FMV condition. The motivating subscription.
  ('11111111-1111-1111-1111-111111111111', 'owner-a', ARRAY['email'],
   ARRAY['95f28a17-224a-4025-96ad-adf8a4c63bfd']::uuid[], 0, 0.60, true, false),
  -- (2) ORDINARY DEALS: a discount floor, no price cap.
  ('22222222-2222-2222-2222-222222222222', 'owner-b', ARRAY['email'],
   ARRAY['95f28a17-224a-4025-96ad-adf8a4c63bfd']::uuid[], 25, NULL, true, false),
  -- (3) INACTIVE.
  ('33333333-3333-3333-3333-333333333333', 'owner-c', ARRAY['email'],
   ARRAY['95f28a17-224a-4025-96ad-adf8a4c63bfd']::uuid[], 25, NULL, false, false);

-- (4) and (5) exercise the set/player filters against the deals pool.
INSERT INTO alert_subscriptions (id, owner_key, channels, collection_ids, min_discount, active, serial_only, set_names)
VALUES ('44444444-4444-4444-4444-444444444444', 'owner-d', ARRAY['email'],
        ARRAY['95f28a17-224a-4025-96ad-adf8a4c63bfd']::uuid[], 25, true, false, ARRAY['Archive']);

INSERT INTO alert_subscriptions (id, owner_key, channels, collection_ids, min_discount, active, serial_only, player_names)
VALUES ('55555555-5555-5555-5555-555555555555', 'owner-e', ARRAY['email'],
        ARRAY['95f28a17-224a-4025-96ad-adf8a4c63bfd']::uuid[], 25, true, false, ARRAY['Damian']),
       ('66666666-6666-6666-6666-666666666666', 'owner-f', ARRAY['email'],
        ARRAY['95f28a17-224a-4025-96ad-adf8a4c63bfd']::uuid[], 25, true, false, ARRAY['Damian Lillard']);

-- ── assertions ─────────────────────────────────────────────────────────────
DO $$
DECLARE r jsonb;
BEGIN
  -- (1) PRICE-ONLY reads the RAW ASK pool, not the deals board.
  r := public.build_deal_alerts_for_subscription('11111111-1111-1111-1111-111111111111');
  PERFORM _assert_eq((r->>'price_only'), 'true', 'a max_price with min_discount=0 is price-only');
  PERFORM _assert_eq((r->>'deals_count'), '1', 'the $0.33 raw ask is visible to a $0.60 price-only alert');
  PERFORM _assert_eq((r->'deals'->0->>'external_id'), '73:9001', 'the row comes from edition_current_ask');
  PERFORM _assert((r->'deals'->0->>'fmv_usd') IS NULL,
                  'a price-only row carries NO fmv — that is the whole point of the pool');
  PERFORM _assert_eq((r->'deals'->0->>'price_only'), 'true', 'the row is flagged as price-pool');
  -- ⚠ The exclusion is the half that regresses silently: a "fix" that unioned
  -- both pools would still satisfy every assertion above.
  PERFORM _assert(NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(r->'deals') d WHERE d->>'external_id' = '73:2785'),
    'a price-only sub must NOT also receive deals-board rows');

  -- (2) An ordinary discount sub reads the deals board, and ONLY that.
  r := public.build_deal_alerts_for_subscription('22222222-2222-2222-2222-222222222222');
  PERFORM _assert_eq((r->>'price_only'), 'false', 'min_discount=25 is not price-only');
  PERFORM _assert_eq((r->>'deals_count'), '1', 'the discounted edition alerts');
  PERFORM _assert_eq((r->'deals'->0->>'external_id'), '73:2785', 'and it is the deals-board row');
  PERFORM _assert(NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(r->'deals') d WHERE d->>'external_id' = '73:9001'),
    'the raw-ask pool must not leak into a normal deals subscription');

  -- (3) Not eligible — an inactive or unknown subscription must SAY so, not
  -- return an empty deal list that reads as "nothing matched".
  r := public.build_deal_alerts_for_subscription('33333333-3333-3333-3333-333333333333');
  PERFORM _assert_eq((r->>'error'), 'not eligible', 'an inactive subscription is not eligible');
  PERFORM _assert(r->'deals' IS NULL, 'and it returns no deals key at all, rather than deals: []');
  r := public.build_deal_alerts_for_subscription('99999999-9999-9999-9999-999999999999');
  PERFORM _assert_eq((r->>'error'), 'not eligible', 'an unknown subscription id is not eligible');

  -- (4) SET NAMES ARE CONTAINMENT: "Archive" must match "Archive Set".
  r := public.build_deal_alerts_for_subscription('44444444-4444-4444-4444-444444444444');
  PERFORM _assert_eq((r->>'deals_count'), '1',
    'a set filter of "Archive" matches the catalogue set "Archive Set"');

  -- (5) PLAYER NAMES STAY EXACT — the deliberate asymmetry.
  r := public.build_deal_alerts_for_subscription('55555555-5555-5555-5555-555555555555');
  PERFORM _assert_eq((r->>'deals_count'), '0',
    'a player filter of "Damian" must NOT match "Damian Lillard" — player names are exact');
  r := public.build_deal_alerts_for_subscription('66666666-6666-6666-6666-666666666666');
  PERFORM _assert_eq((r->>'deals_count'), '1',
    'the full player name does match (so the case above is a real filter, not a broken fixture)');

  RAISE NOTICE '✓ build_deal_alerts_for_subscription invariants pass';
END $$;

-- deals_count must be the SUM of both passes, not just the edition pass. Added
-- as its own block so the serial fixture cannot perturb the cases above.
INSERT INTO topshot_underpriced_serials_board
  (edition_id, edition_key, external_id, player_name, set_name, tier,
   circulation_count, thumbnail_url, nft_id, serial_number, ask_usd,
   listing_resource_id, listing_url, listed_at, last_seen_at, edition_fmv_usd,
   confidence, serial_bucket, serial_fmv_usd, serial_multiplier, discount_usd,
   discount_pct, estimate_quality)
VALUES
  (gen_random_uuid(), '73:2785', '73:2785', 'Damian Lillard', 'Archive Set', 'COMMON',
   12000, NULL, 'nft-1', 1, 50.00, NULL, NULL, now(), now(), 40.00,
   'HIGH', 'first', 100.00, 2.5, 50.00, 50.0, 'tight');

DO $$
DECLARE r jsonb;
BEGIN
  r := public.build_deal_alerts_for_subscription('22222222-2222-2222-2222-222222222222');
  PERFORM _assert_eq((r->>'serial_deals_count'), '1', 'the serial pass finds the tight-estimate row');
  PERFORM _assert_eq((r->>'deals_count'), '2',
    'deals_count SUMS the edition pass and the serial pass');

  -- ⚠ And the serial pass is a strict ADDITION for a price-only sub: it has no
  -- price-only branch by design (every row on that board exists because of an
  -- FMV gap), but it is still bounded by max_price. At $0.60 the $50 serial is
  -- out, so the price-only preview stays at its single raw-ask row.
  r := public.build_deal_alerts_for_subscription('11111111-1111-1111-1111-111111111111');
  PERFORM _assert_eq((r->>'serial_deals_count'), '0', 'max_price still bounds the serial pass');
  PERFORM _assert_eq((r->>'deals_count'), '1', 'so a price-only preview is unchanged by it');

  RAISE NOTICE '✓ build_deal_alerts_for_subscription deals_count invariants pass';
END $$;

ROLLBACK;
