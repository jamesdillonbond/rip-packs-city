-- audit_20261102_221_wmc_placeholder_player_names
--
-- #221 residue (b): 148 wallet_moments_cache rows carry a PLACEHOLDER player name
-- the metadata fills cannot see — they COALESCE over NULL only, and '' / ' ' /
-- 'Unknown Play' / '<invalid Value>' are not NULL. Top Shot 'Unknown Play' 90 +
-- '<invalid Value>' 1, All Day '' 46 + ' ' 11 (measured 2026-11-02). All legacy:
-- newest created 2026-05-08, i.e. no live writer produces them any more. Every row's
-- edition carries a name (team/franchise editions name the franchise — R8's
-- convention), so the repair copies editions.player_name, collection-scoped (#142).
--
-- Backup: audit_20261102_221_wmc_placeholder_names_backup (id, old player_name).
-- Guarded: raises unless exactly the measured 148 rows change.
--
-- anon-exec: n/a — no function created
--
-- REVERT:
--   UPDATE public.wallet_moments_cache w SET player_name = b.player_name
--     FROM public.audit_20261102_221_wmc_placeholder_names_backup b WHERE w.id = b.id;

CREATE TABLE public.audit_20261102_221_wmc_placeholder_names_backup AS
SELECT w.id, w.collection_id, w.edition_key, w.player_name
  FROM public.wallet_moments_cache w
  JOIN public.editions e ON e.external_id = w.edition_key AND e.collection_id = w.collection_id
 WHERE (w.player_name IN ('Unknown Play', '<invalid Value>') OR trim(w.player_name) = '')
   AND e.player_name IS NOT NULL AND trim(e.player_name) <> '';

ALTER TABLE public.audit_20261102_221_wmc_placeholder_names_backup ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.audit_20261102_221_wmc_placeholder_names_backup FROM PUBLIC, anon, authenticated;

DO $$
DECLARE v_backed int; v_upd int;
BEGIN
  SELECT count(*) INTO v_backed FROM public.audit_20261102_221_wmc_placeholder_names_backup;
  IF v_backed <> 148 THEN
    RAISE EXCEPTION 'expected 148 placeholder rows, found %', v_backed;
  END IF;
  UPDATE public.wallet_moments_cache w
     SET player_name = e.player_name
    FROM public.audit_20261102_221_wmc_placeholder_names_backup b
    JOIN public.editions e ON e.external_id = b.edition_key AND e.collection_id = b.collection_id
   WHERE w.id = b.id AND w.collection_id = b.collection_id;
  GET DIAGNOSTICS v_upd = ROW_COUNT;
  IF v_upd <> 148 THEN
    RAISE EXCEPTION 'expected to update 148 rows, updated %', v_upd;
  END IF;
END $$;
