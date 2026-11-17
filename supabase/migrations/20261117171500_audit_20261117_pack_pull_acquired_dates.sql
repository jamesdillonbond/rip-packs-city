-- audit_20261117_pack_pull_acquired_dates
--
-- 2026-11-17 (Claude Code cloud; Trevor: "Keep going and working through those still open").
--
-- WHY. A pack_pull acquisition row was written with acquired_date NULL by every fact-only pull writer:
-- backfill_acq_own_history_20261114 arm C (jobid 886, every 2 h) and fill_acquisitions_for_moments arm C
-- (20261117043000). Measured 2026-11-17: 31,230 pack_pull rows with a NULL date — Top Shot 13,261, All Day
-- 16,812, Golazos 884, Pinnacle 273 — so the binder's Acquired column read "—" for pulls we had PROVEN.
-- The open time is already in our tables for three collections:
--   · Top Shot  — topshot_arrival_provenance kind P (the Dune pull arrival into that wallet; day precision): 13,151
--   · Golazos   — golazos_pack_open_pulls → golazos_pack_opens.opened_at (opener = the wallet): 884
--   · Pinnacle  — pinnacle_pack_opens.opened_at (opener = the wallet, nft in nft_ids): 273
--   · All Day   — allday_pack_pull carries no open time (tx_hash only on 5,567) → left NULL here.
--
-- WHAT.
--   1. pack_pull_open_time(collection, wallet, nft) — the lookup above; NULL when not proven.
--   2. BEFORE INSERT trigger trg_moment_acq_pack_pull_date — fills acquired_date on any pack_pull row inserted
--      without one. Fixing the WRITE side once covers both writers above and any future one (a read-side fix
--      would be re-broken by the next insert). WHEN-gated, so other inserts pay nothing but the WHEN test.
--   3. backfill_pack_pull_dates(p_limit) — dates the existing NULL rows by the same lookup; every row archived
--      in flowty_archive.acq_pack_pull_date_20261117.
--   4. fill_acquisitions_for_moments arm C learns Golazos' own pull tables (it read only pack_open_pulls, which
--      holds no Golazos pulls: 157 held Golazos moments on saved wallets had no acquisition row at all, all 157
--      present in golazos_pack_open_pulls). Body otherwise byte-identical to 20261117043000 (live md5 8414a6e0…
--      verified against that file immediately before).
--
-- anon-exec: revoked (pack_pull_open_time) — internal lookup; service_role only.
-- anon-exec: revoked (backfill_pack_pull_dates) — writes moment_acquisitions; service_role only.
-- anon-exec: revoked (moment_acq_pack_pull_date) — trigger function; runs as the inserting role, never called directly.
-- anon-exec: revoked (fill_acquisitions_for_moments) — unchanged grant; service_role only.
--
-- REVERT:
--   UPDATE moment_acquisitions m SET acquired_date = NULL FROM flowty_archive.acq_pack_pull_date_20261117 r WHERE m.id = r.acq_id;
--   DROP TRIGGER trg_moment_acq_pack_pull_date ON public.moment_acquisitions;
--   DROP FUNCTION public.moment_acq_pack_pull_date(); DROP FUNCTION public.backfill_pack_pull_dates(integer);
--   DROP FUNCTION public.pack_pull_open_time(uuid, text, text);
--   Re-apply 20261117043000 for the previous fill_acquisitions_for_moments body.

CREATE TABLE IF NOT EXISTS flowty_archive.acq_pack_pull_date_20261117 (
  acq_id uuid PRIMARY KEY,
  collection_id uuid NOT NULL,
  new_date timestamptz NOT NULL,
  written_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON flowty_archive.acq_pack_pull_date_20261117 FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.pack_pull_open_time(p_collection_id uuid, p_wallet text, p_nft_id text)
RETURNS timestamptz
LANGUAGE sql
STABLE
SET search_path TO 'public', 'pg_temp'
AS $fn$
  SELECT CASE p_collection_id
    WHEN '95f28a17-224a-4025-96ad-adf8a4c63bfd' THEN
      (SELECT max(p.arrival_date)::timestamptz FROM topshot_arrival_provenance p
        WHERE p.wallet = p_wallet AND p.nft_id = p_nft_id AND p.kind = 'P')
    WHEN '06248cc4-b85f-47cd-af67-1855d14acd75' THEN
      (SELECT go.opened_at FROM golazos_pack_open_pulls gp JOIN golazos_pack_opens go ON go.pack_nft_id = gp.pack_nft_id
        WHERE gp.nft_id = p_nft_id AND go.opener_address = p_wallet)
    WHEN '7dd9dd11-e8b6-45c4-ac99-71331f959714' THEN
      (SELECT max(po.opened_at) FROM pinnacle_pack_opens po
        WHERE po.opener_address = p_wallet AND p_nft_id = ANY (po.nft_ids))
  END
$fn$;

CREATE OR REPLACE FUNCTION public.moment_acq_pack_pull_date()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
BEGIN
  -- SECURITY DEFINER: the inserting role may not hold EXECUTE on pack_pull_open_time (revoked from anon /
  -- authenticated); as definer the lookup runs as the owner, so no insert can fail on this trigger's account.
  NEW.acquired_date := public.pack_pull_open_time(NEW.collection_id, NEW.wallet, NEW.nft_id);
  RETURN NEW;
END;
$fn$;

CREATE OR REPLACE TRIGGER trg_moment_acq_pack_pull_date
  BEFORE INSERT ON public.moment_acquisitions
  FOR EACH ROW
  WHEN (NEW.acquisition_method = 'pack_pull' AND NEW.acquired_date IS NULL)
  EXECUTE FUNCTION public.moment_acq_pack_pull_date();

CREATE OR REPLACE FUNCTION public.backfill_pack_pull_dates(p_limit integer DEFAULT 5000)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $fn$
DECLARE
  v_out jsonb;
BEGIN
  WITH cand AS (
    SELECT ma.id, ma.collection_id, public.pack_pull_open_time(ma.collection_id, ma.wallet, ma.nft_id) AS d
    FROM moment_acquisitions ma
    WHERE ma.acquisition_method = 'pack_pull' AND ma.acquired_date IS NULL
      AND ma.collection_id IN ('95f28a17-224a-4025-96ad-adf8a4c63bfd', '06248cc4-b85f-47cd-af67-1855d14acd75',
                               '7dd9dd11-e8b6-45c4-ac99-71331f959714')
      AND NOT EXISTS (SELECT 1 FROM flowty_archive.acq_pack_pull_date_20261117 r WHERE r.acq_id = ma.id)
  ), dated AS (
    SELECT * FROM cand WHERE d IS NOT NULL LIMIT p_limit
  ), upd AS (
    UPDATE moment_acquisitions m SET acquired_date = t.d
    FROM dated t WHERE m.id = t.id AND m.acquired_date IS NULL
    RETURNING m.id, m.collection_id, m.acquired_date
  ), rec AS (
    INSERT INTO flowty_archive.acq_pack_pull_date_20261117 (acq_id, collection_id, new_date)
    SELECT id, collection_id, acquired_date FROM upd
    ON CONFLICT (acq_id) DO NOTHING
    RETURNING 1
  )
  SELECT jsonb_build_object('dated', (SELECT count(*) FROM rec),
                            'undatable_remaining', (SELECT count(*) FROM cand WHERE d IS NULL))
    INTO v_out;
  RETURN v_out;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.fill_acquisitions_for_moments(p_wallet text, p_collection_id uuid, p_nft_ids text[])
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
SET statement_timeout TO '20s'
AS $fn$
DECLARE
  v_pin uuid := '7dd9dd11-e8b6-45c4-ac99-71331f959714';
  v_ad  uuid := 'dee28451-5d62-409e-a1ad-a83f763ac070';
  v_a text[] := '{}'; v_b text[] := '{}'; v_c text[] := '{}';
BEGIN
  IF p_wallet IS NULL OR p_collection_id IS NULL THEN RAISE EXCEPTION 'wallet and collection required'; END IF;
  IF p_nft_ids IS NULL OR cardinality(p_nft_ids) = 0 THEN
    RETURN jsonb_build_object('a_buys', 0, 'b_unknown_to_buy', 0, 'c_pulls', 0, 'filled_ids', '[]'::jsonb);
  END IF;
  IF cardinality(p_nft_ids) > 500 THEN RAISE EXCEPTION 'at most 500 ids per call (got %)', cardinality(p_nft_ids); END IF;

  -- A. buys with no row
  WITH ids AS (SELECT DISTINCT unnest(p_nft_ids) AS nft_id),
  last AS (
    SELECT i.nft_id, l.buyer, l.seller, l.price, l.sold_at, l.tx, l.is_offer, l.ok_ccy
    FROM ids i
    JOIN LATERAL (
      SELECT s.buyer_address AS buyer, s.seller_address AS seller, s.price_usd AS price, s.sold_at,
             COALESCE(s.transaction_hash, 'own_sale:' || s.id::text) AS tx,
             (s.offer_id IS NOT NULL OR s.source = 'offer_fill') AS is_offer,
             (COALESCE(s.currency, 'USD') IN ('USD', 'DUC', 'USDC')) AS ok_ccy
      FROM sales s
      WHERE p_collection_id <> v_pin AND s.nft_id = i.nft_id AND s.collection_id = p_collection_id
      UNION ALL
      SELECT ps.buyer_address, ps.seller_address, ps.sale_price_usd, ps.sold_at,
             COALESCE(NULLIF(split_part(ps.id::text, '_', 1), ''), 'own_sale:' || ps.id::text), false, true
      FROM pinnacle_sales ps
      WHERE p_collection_id = v_pin AND ps.nft_id = i.nft_id
      ORDER BY 4 DESC
      LIMIT 1
    ) l ON true
  ), ins AS (
    INSERT INTO moment_acquisitions (nft_id, wallet, buy_price, acquired_date, acquired_type, seller_address,
      transaction_hash, source, collection_id, acquisition_method, acquisition_confidence)
    SELECT l.nft_id, p_wallet, l.price, l.sold_at, 1, l.seller, l.tx, 'arrival_fill', p_collection_id,
           CASE WHEN l.is_offer THEN 'offer_accepted' ELSE 'marketplace' END, 'verified'
    FROM last l
    WHERE l.buyer = p_wallet AND l.seller IS DISTINCT FROM p_wallet AND l.price > 0 AND l.ok_ccy
      AND NOT EXISTS (SELECT 1 FROM moment_acquisitions ma WHERE ma.nft_id = l.nft_id AND ma.wallet = p_wallet
                        AND ma.collection_id = p_collection_id)
    ON CONFLICT (nft_id, wallet, transaction_hash) DO NOTHING
    RETURNING id, nft_id, buy_price
  ), rec AS (
    INSERT INTO flowty_archive.acq_own_history_backfill_20261114 (acq_id, wallet, collection_id, nft_id, arm, price)
    SELECT id, p_wallet, p_collection_id, nft_id, 'A_buy_arrival', buy_price FROM ins RETURNING nft_id
  )
  SELECT COALESCE(array_agg(nft_id), '{}') INTO v_a FROM rec;

  -- B. a lone 'unknown', unpriced row proven by the same sale
  WITH ids AS (SELECT DISTINCT unnest(p_nft_ids) AS nft_id),
  last AS (
    SELECT i.nft_id, l.buyer, l.seller, l.price, l.sold_at, l.is_offer, l.ok_ccy
    FROM ids i
    JOIN LATERAL (
      SELECT s.buyer_address AS buyer, s.seller_address AS seller, s.price_usd AS price, s.sold_at,
             (s.offer_id IS NOT NULL OR s.source = 'offer_fill') AS is_offer,
             (COALESCE(s.currency, 'USD') IN ('USD', 'DUC', 'USDC')) AS ok_ccy
      FROM sales s
      WHERE p_collection_id <> v_pin AND s.nft_id = i.nft_id AND s.collection_id = p_collection_id
      UNION ALL
      SELECT ps.buyer_address, ps.seller_address, ps.sale_price_usd, ps.sold_at, false, true
      FROM pinnacle_sales ps
      WHERE p_collection_id = v_pin AND ps.nft_id = i.nft_id
      ORDER BY 4 DESC
      LIMIT 1
    ) l ON true
  ), tgt AS (
    SELECT ma.id, ma.nft_id, to_jsonb(ma) AS prior, l.price, l.seller, l.sold_at, l.is_offer
    FROM moment_acquisitions ma JOIN last l ON l.nft_id = ma.nft_id
    WHERE ma.wallet = p_wallet AND ma.collection_id = p_collection_id
      AND ma.acquisition_method = 'unknown' AND ma.buy_price IS NULL
      AND l.buyer = p_wallet AND l.seller IS DISTINCT FROM p_wallet AND l.price > 0 AND l.ok_ccy
      AND (SELECT count(*) FROM moment_acquisitions m2 WHERE m2.nft_id = ma.nft_id AND m2.wallet = p_wallet
             AND m2.collection_id = p_collection_id) = 1
  ), upd AS (
    UPDATE moment_acquisitions m
    SET acquisition_method = CASE WHEN t.is_offer THEN 'offer_accepted' ELSE 'marketplace' END,
        buy_price = t.price, seller_address = t.seller, acquired_date = t.sold_at,
        acquisition_confidence = 'verified', source = 'arrival_fill'
    FROM tgt t WHERE m.id = t.id
    RETURNING m.id
  ), rec AS (
    INSERT INTO flowty_archive.acq_own_history_backfill_20261114 (acq_id, wallet, collection_id, nft_id, arm, price, prior)
    SELECT t.id, p_wallet, p_collection_id, t.nft_id, 'B_unknown_arrival', t.price, t.prior FROM tgt t JOIN upd u ON u.id = t.id
    RETURNING nft_id
  )
  SELECT COALESCE(array_agg(nft_id), '{}') INTO v_b FROM rec;

  -- C. pulls this wallet opened, never sold anywhere since
  WITH ids AS (SELECT DISTINCT unnest(p_nft_ids) AS nft_id),
  pulls AS (
    SELECT i.nft_id FROM ids i
    WHERE NOT EXISTS (SELECT 1 FROM sales s WHERE p_collection_id <> v_pin AND s.nft_id = i.nft_id AND s.collection_id = p_collection_id)
      AND NOT EXISTS (SELECT 1 FROM pinnacle_sales ps WHERE p_collection_id = v_pin AND ps.nft_id = i.nft_id)
      AND NOT EXISTS (SELECT 1 FROM moment_acquisitions ma WHERE ma.nft_id = i.nft_id AND ma.wallet = p_wallet
                        AND ma.collection_id = p_collection_id)
      AND (
        (p_collection_id <> v_pin AND EXISTS (SELECT 1 FROM pack_open_pulls o WHERE o.collection_id = p_collection_id
            AND o.nft_id = i.nft_id AND o.opener_address = p_wallet))
        OR (p_collection_id = v_ad AND EXISTS (SELECT 1 FROM allday_pack_pull a WHERE a.moment_nft_id = i.nft_id
            AND a.opener_address = p_wallet))
        OR (p_collection_id = v_pin AND EXISTS (SELECT 1 FROM pinnacle_pack_opens po WHERE po.opener_address = p_wallet
            AND i.nft_id = ANY (po.nft_ids)))
        -- 2026-11-17: Golazos records its pulls in its own tables, not pack_open_pulls.
        OR (p_collection_id = '06248cc4-b85f-47cd-af67-1855d14acd75' AND EXISTS (
            SELECT 1 FROM golazos_pack_open_pulls gp JOIN golazos_pack_opens go ON go.pack_nft_id = gp.pack_nft_id
            WHERE gp.nft_id = i.nft_id AND go.opener_address = p_wallet))
      )
  ), ins AS (
    INSERT INTO moment_acquisitions (nft_id, wallet, buy_price, acquired_type, transaction_hash, source, collection_id,
      acquisition_method, acquisition_confidence)
    SELECT nft_id, p_wallet, 0, 1, 'own_pull:' || nft_id, 'arrival_fill', p_collection_id, 'pack_pull', 'verified'
    FROM pulls
    ON CONFLICT (nft_id, wallet, transaction_hash) DO NOTHING
    RETURNING id, nft_id
  ), rec AS (
    INSERT INTO flowty_archive.acq_own_history_backfill_20261114 (acq_id, wallet, collection_id, nft_id, arm, price)
    SELECT id, p_wallet, p_collection_id, nft_id, 'C_pull_arrival', 0 FROM ins RETURNING nft_id
  )
  SELECT COALESCE(array_agg(nft_id), '{}') INTO v_c FROM rec;

  RETURN jsonb_build_object('a_buys', cardinality(v_a), 'b_unknown_to_buy', cardinality(v_b), 'c_pulls', cardinality(v_c),
    'filled_ids', to_jsonb(v_a || v_b || v_c));
END
$fn$;


REVOKE ALL ON FUNCTION public.pack_pull_open_time(uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.pack_pull_open_time(uuid, text, text) TO service_role;
REVOKE ALL ON FUNCTION public.moment_acq_pack_pull_date() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.backfill_pack_pull_dates(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.backfill_pack_pull_dates(integer) TO service_role;
REVOKE ALL ON FUNCTION public.fill_acquisitions_for_moments(text, uuid, text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fill_acquisitions_for_moments(text, uuid, text[]) TO service_role;
