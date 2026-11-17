-- audit_20261112_panini_ask_cap_covers_every_sale_tier — 2026-11-12 ~10:35 AM PT (Cowork cloud; Trevor 10:09 AM:
-- "Keep going … Make decisions based upon what makes sense, what is best for RPC long term, and what's best for
-- our users").
--
-- #202 (10-26) capped a Panini LOW price at the edition's lowest live ask and left the all-tier variant unshipped:
-- "it was not the registered candidate and it reprices HIGH on one listing; it needs its own read". This is that
-- read, taken twice.
--   panini_fmv_ask_cap_shadow_backtest(14), 11-12 (variant capped_all vs published):
--     the 76 sales the all-tier cap changes   within +/-25 % 11.8 -> 30.3, median ratio 2.17 -> 1.40
--       HIGH n 58: 10.3 -> 25.9, 2.50 -> 1.50 · MEDIUM n 6: 16.7 -> 66.7 · STALE n 12: 16.7 -> 33.3
--     all 4,662 sales                          44.8 -> 45.1; HIGH 49.9 -> 50.2, MEDIUM 34.0 -> 34.5, STALE 46.8 -> 51.1;
--     no tier gets worse.
--   10-26 read (the #202 entry): changed n 106, 1.9 -> 48.1.
-- The "one listing" worry, measured on the current rows: 1,030 HIGH / MEDIUM / STALE prices sit above the lowest
-- live ask; 26 of them rest on a single listing. A price above what a collector can buy the card for today, from
-- several sellers, is not a fair value.
--
-- WHAT CHANGES: the guard's tier test, LOW -> LOW, MEDIUM, HIGH, STALE. ASK_ONLY is already a fraction of the ask
-- and NO_DATA has no price. Everything else in the body is unchanged: only a LISTED serial with price > 0 re-read
-- in the last 7 days sets the cap, and it only ever LOWERS. The function keeps its name (it is pinned and
-- triggered under it); the name now understates it.
-- Size at apply (latest rows): HIGH 212 ($1,086 -> $748), MEDIUM 750 ($13,463 -> $9,514), STALE 68
-- ($60,439 -> $46,544). No re-stamp of current rows: the bridge re-inserts each edition as it is re-walked.
--
-- APPLIED IN THE DASHBOARD SQL EDITOR as a checksum-guarded splice of the live definition (Trevor 8:15 AM: "Use
-- chrome to do the SQL"); the live body was then checked equal to this file's. No schema_migrations row.
-- anon-exec: unchanged (fmv_snapshots_cap_panini_low_to_live_ask) — CREATE OR REPLACE keeps its ACL (EXECUTE revoked 10-26).
-- EXIT: panini_fmv_ask_cap_shadow_backtest(7) weekly — published HIGH / MEDIUM / STALE should read the capped_all rows.
-- FALSIFIER: published HIGH within +/-25 % below 49.9 on two consecutive weekly reads -> re-apply the 20261027030854 body.
-- REVERT: re-apply the function body in 20261027030854.

DO $guard$
BEGIN
  IF (SELECT md5(trim(regexp_replace(prosrc, '\s+', ' ', 'g'))) FROM pg_proc
       WHERE oid = 'public.fmv_snapshots_cap_panini_low_to_live_ask()'::regprocedure) <> '5ff64fb47877d1774da2609941fefb75' THEN
    RAISE EXCEPTION 'fmv_snapshots_cap_panini_low_to_live_ask is not the 20261027030854 body; re-read it and re-base';
  END IF;
END
$guard$;

CREATE OR REPLACE FUNCTION public.fmv_snapshots_cap_panini_low_to_live_ask()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  -- Panini Blockchain (collections.id). Scoped by measurement (2026-10-26, #202).
  -- 2026-11-12: every sale-derived tier, not LOW alone (the all-tier shadow read; see the migration header).
  c_panini constant uuid := 'd1a0a7f5-609a-49f4-a1a7-4eaac55b020b';
  v_ask numeric;
BEGIN
  IF NEW.collection_id = c_panini
     AND NEW.confidence IN ('LOW', 'MEDIUM', 'HIGH', 'STALE')
     AND NEW.fmv_usd IS NOT NULL
     AND NEW.edition_id IS NOT NULL
  THEN
    SELECT min(s.price_usd)
      INTO v_ask
      FROM public.editions e
      JOIN public.panini_card_serials s
        ON s.edition_external_id = e.external_id::text
     WHERE e.id = NEW.edition_id
       AND s.is_listed
       AND s.price_usd > 0
       AND s.captured_at > now() - interval '7 days';
    IF v_ask IS NOT NULL AND v_ask > 0 AND NEW.fmv_usd > v_ask THEN
      NEW.fmv_usd := round(v_ask, 2);
      NEW.algo_version := COALESCE(NEW.algo_version, '') || '_askcap';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
