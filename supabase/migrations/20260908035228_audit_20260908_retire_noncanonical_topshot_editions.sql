-- audit_20260908: the 6,597 non-canonical (UUID-pair) Top Shot `editions` rows are RETIRED — backed up
-- row-for-row into audit tables, then deleted with every dependent row — so the go-live accuracy
-- metric is one honest number instead of two.
--
-- DECISION (Trevor delegated 2026-09-07 PT: "use your best judgement … what's best for RPC long term
-- and for our users"). The 08-28 R41 decision made `topshot_fmv_high_med_share_pct` an ALL-ROWS
-- metric on the premise that the non-canonical rows were "STILL BEING MINTED — a live population".
-- Measured tonight: they are not, and they are reachable by nobody.
--   editions matched by `collection_id = TS AND external_id !~ '^[0-9]+:[0-9]+(::[0-9]+)?$'` : 6,597
--   created: 6,382 in the week of 2026-06-01 (a bulk backfill), a trickle of 1–39/week to 08-20, none since
--   sales referencing them: 0 (ever) · wallet_moments_cache by edition_key: 0 · edition_offers: 0 ·
--   badge_editions: 0 · nft_edition_map: 0 · topshot_ownership: 0 · trophy_moments / watchlists /
--   wishlists / portfolio_moments / marketplace_offers / cached_listings_v2 / atlas_edition_map: 0
--   what DOES reference them (all backed up below): fmv_snapshots 45,088 · edition_fmv_current 6,426
--   · price_snapshots 3,740 · fmv_calibration_caps 262 · moments 25 (no canonical twin — these nfts
--   re-enter v_moments_needing_hydration and get hydrated onto their real edition by jobids 468/469)
--   · offers 18 (4 open) · fmv_phantom_attempts 2 · outbound_clicks 14 (no FK, analytics history, kept)
-- The repo's own doctrine (app/api/ingest/route.ts): "A non-canonical (UUID-pair) external_id is an
-- inert dupe edition — a sale/moment/edition must NEVER be keyed onto one." Their only writer was the
-- GraphQL ingest's UUID fallback, whose host has been dead since ~08-28 and whose GHA step was
-- retired tonight; `editions_block_topshot_uuid_dupe_trg` blocks new ones at the table.
-- Effect on the gate metric: `topshot_fmv_high_med_share_pct` reads 36.2 % (all rows) with these
-- 6,426 dead FMV rows in the denominator and 53.3 % without them — the 54.5 % the go-live bar cites
-- (08-13) was a canonical reading, so "50 % all rows" needed ~73 % of canonical. After this the
-- all-rows and canonical figures are the SAME population, which honours R41's intent (no
-- cherry-picking) better than the residue did. `topshot_fmv_pct_stale_30d` loses its ~32 % structural
-- floor for the same reason (its breach_at 50 was calibrated with the floor; re-read after the next
-- leg run at :48 of 1/7/13/19Z).
--
-- SAFETY: `zzz_guard_del_editions` blocks >25 editions deletes unless `rpc.allow_bulk_delete` is set
-- IN the transaction (rpc_delete_guard, 2026-06-27) — set below, deliberately. Every deleted row is
-- copied first; the DO block at the end asserts every count against the backup and RAISEs (rolling
-- the whole transaction back) on any mismatch. Backups are RLS-on, service_role-only, like every
-- audit_* table.
--
-- REVERT (order matters; the uuid-dupe trigger must be disabled for the editions re-insert):
--   BEGIN;
--   ALTER TABLE public.editions DISABLE TRIGGER editions_block_topshot_uuid_dupe_trg;
--   INSERT INTO public.editions SELECT * FROM public.audit_20260908_ts_noncanonical_editions;
--   ALTER TABLE public.editions ENABLE TRIGGER editions_block_topshot_uuid_dupe_trg;
--   INSERT INTO public.fmv_snapshots SELECT * FROM public.audit_20260908_ts_noncanonical_fmv_snapshots;
--   INSERT INTO public.edition_fmv_current SELECT * FROM public.audit_20260908_ts_noncanonical_edition_fmv_current;
--   INSERT INTO public.price_snapshots SELECT * FROM public.audit_20260908_ts_noncanonical_price_snapshots;
--   INSERT INTO public.fmv_calibration_caps SELECT * FROM public.audit_20260908_ts_noncanonical_fmv_calibration_caps;
--   INSERT INTO public.moments SELECT * FROM public.audit_20260908_ts_noncanonical_moments;
--   INSERT INTO public.offers SELECT * FROM public.audit_20260908_ts_noncanonical_offers;
--   INSERT INTO public.fmv_phantom_attempts SELECT * FROM public.audit_20260908_ts_noncanonical_fmv_phantom_attempts;
--   COMMIT;
-- (fmv_snapshots triggers may reject some historical rows on re-insert — disable
--  fmv_snapshots_block_phantoms_trg / _block_stale_ingest_algo_trg for the revert if they do.)

SET LOCAL rpc.allow_bulk_delete = 'on';

CREATE TABLE public.audit_20260908_ts_noncanonical_editions AS
  SELECT e.* FROM public.editions e
   WHERE e.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'
     AND e.external_id !~ '^[0-9]+:[0-9]+(::[0-9]+)?$';

CREATE TABLE public.audit_20260908_ts_noncanonical_fmv_snapshots AS
  SELECT f.* FROM public.fmv_snapshots f WHERE f.edition_id IN (SELECT id FROM public.audit_20260908_ts_noncanonical_editions);
CREATE TABLE public.audit_20260908_ts_noncanonical_edition_fmv_current AS
  SELECT f.* FROM public.edition_fmv_current f WHERE f.edition_id IN (SELECT id FROM public.audit_20260908_ts_noncanonical_editions);
CREATE TABLE public.audit_20260908_ts_noncanonical_price_snapshots AS
  SELECT p.* FROM public.price_snapshots p WHERE p.edition_id IN (SELECT id FROM public.audit_20260908_ts_noncanonical_editions);
CREATE TABLE public.audit_20260908_ts_noncanonical_fmv_calibration_caps AS
  SELECT c.* FROM public.fmv_calibration_caps c WHERE c.edition_id::text IN (SELECT id::text FROM public.audit_20260908_ts_noncanonical_editions);
CREATE TABLE public.audit_20260908_ts_noncanonical_moments AS
  SELECT m.* FROM public.moments m WHERE m.edition_id IN (SELECT id FROM public.audit_20260908_ts_noncanonical_editions);
CREATE TABLE public.audit_20260908_ts_noncanonical_offers AS
  SELECT o.* FROM public.offers o WHERE o.edition_id IN (SELECT id FROM public.audit_20260908_ts_noncanonical_editions);
CREATE TABLE public.audit_20260908_ts_noncanonical_fmv_phantom_attempts AS
  SELECT a.* FROM public.fmv_phantom_attempts a WHERE a.edition_id::text IN (SELECT id::text FROM public.audit_20260908_ts_noncanonical_editions);

DO $$
DECLARE n_ed int; n_fs int; n_efc int; n_ps int; n_cap int; n_mo int; n_of int; n_ph int; d int;
BEGIN
  SELECT count(*) INTO n_ed  FROM public.audit_20260908_ts_noncanonical_editions;
  SELECT count(*) INTO n_fs  FROM public.audit_20260908_ts_noncanonical_fmv_snapshots;
  SELECT count(*) INTO n_efc FROM public.audit_20260908_ts_noncanonical_edition_fmv_current;
  SELECT count(*) INTO n_ps  FROM public.audit_20260908_ts_noncanonical_price_snapshots;
  SELECT count(*) INTO n_cap FROM public.audit_20260908_ts_noncanonical_fmv_calibration_caps;
  SELECT count(*) INTO n_mo  FROM public.audit_20260908_ts_noncanonical_moments;
  SELECT count(*) INTO n_of  FROM public.audit_20260908_ts_noncanonical_offers;
  SELECT count(*) INTO n_ph  FROM public.audit_20260908_ts_noncanonical_fmv_phantom_attempts;
  -- The population measured before writing this migration. A drift here means the world moved; stop.
  IF n_ed <> 6597 THEN RAISE EXCEPTION 'editions population is % (expected 6597) — re-measure before retiring', n_ed; END IF;
  IF n_mo > 25 OR n_of > 18 THEN RAISE EXCEPTION 'dependents grew (moments %, offers %) — re-measure', n_mo, n_of; END IF;

  DELETE FROM public.offers WHERE edition_id IN (SELECT id FROM public.audit_20260908_ts_noncanonical_editions);
  GET DIAGNOSTICS d = ROW_COUNT; IF d <> n_of THEN RAISE EXCEPTION 'offers: deleted % vs backed up %', d, n_of; END IF;
  DELETE FROM public.moments WHERE edition_id IN (SELECT id FROM public.audit_20260908_ts_noncanonical_editions);
  GET DIAGNOSTICS d = ROW_COUNT; IF d <> n_mo THEN RAISE EXCEPTION 'moments: deleted % vs backed up %', d, n_mo; END IF;
  DELETE FROM public.fmv_phantom_attempts WHERE edition_id::text IN (SELECT id::text FROM public.audit_20260908_ts_noncanonical_editions);
  GET DIAGNOSTICS d = ROW_COUNT; IF d <> n_ph THEN RAISE EXCEPTION 'fmv_phantom_attempts: deleted % vs backed up %', d, n_ph; END IF;
  DELETE FROM public.fmv_calibration_caps WHERE edition_id::text IN (SELECT id::text FROM public.audit_20260908_ts_noncanonical_editions);
  GET DIAGNOSTICS d = ROW_COUNT; IF d <> n_cap THEN RAISE EXCEPTION 'fmv_calibration_caps: deleted % vs backed up %', d, n_cap; END IF;
  DELETE FROM public.price_snapshots WHERE edition_id IN (SELECT id FROM public.audit_20260908_ts_noncanonical_editions);
  GET DIAGNOSTICS d = ROW_COUNT; IF d <> n_ps THEN RAISE EXCEPTION 'price_snapshots: deleted % vs backed up %', d, n_ps; END IF;
  DELETE FROM public.edition_fmv_current WHERE edition_id IN (SELECT id FROM public.audit_20260908_ts_noncanonical_editions);
  GET DIAGNOSTICS d = ROW_COUNT; IF d <> n_efc THEN RAISE EXCEPTION 'edition_fmv_current: deleted % vs backed up %', d, n_efc; END IF;
  DELETE FROM public.fmv_snapshots WHERE edition_id IN (SELECT id FROM public.audit_20260908_ts_noncanonical_editions);
  GET DIAGNOSTICS d = ROW_COUNT; IF d <> n_fs THEN RAISE EXCEPTION 'fmv_snapshots: deleted % vs backed up %', d, n_fs; END IF;
  DELETE FROM public.editions WHERE id IN (SELECT id FROM public.audit_20260908_ts_noncanonical_editions);
  GET DIAGNOSTICS d = ROW_COUNT; IF d <> n_ed THEN RAISE EXCEPTION 'editions: deleted % vs backed up %', d, n_ed; END IF;

  RAISE NOTICE 'retired % editions, % fmv_snapshots, % edition_fmv_current, % price_snapshots, % caps, % moments, % offers, % phantom attempts', n_ed, n_fs, n_efc, n_ps, n_cap, n_mo, n_of, n_ph;
END $$;

ALTER TABLE public.audit_20260908_ts_noncanonical_editions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_20260908_ts_noncanonical_fmv_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_20260908_ts_noncanonical_edition_fmv_current ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_20260908_ts_noncanonical_price_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_20260908_ts_noncanonical_fmv_calibration_caps ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_20260908_ts_noncanonical_moments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_20260908_ts_noncanonical_offers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_20260908_ts_noncanonical_fmv_phantom_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20260908_ts_noncanonical_editions, public.audit_20260908_ts_noncanonical_fmv_snapshots,
  public.audit_20260908_ts_noncanonical_edition_fmv_current, public.audit_20260908_ts_noncanonical_price_snapshots,
  public.audit_20260908_ts_noncanonical_fmv_calibration_caps, public.audit_20260908_ts_noncanonical_moments,
  public.audit_20260908_ts_noncanonical_offers, public.audit_20260908_ts_noncanonical_fmv_phantom_attempts
  FROM PUBLIC, anon, authenticated;
