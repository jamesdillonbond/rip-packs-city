-- anon-exec: revoked — series_display_label needs no anon or authenticated grant; its only callers are SECURITY DEFINER readers that execute it as their definer. The REVOKE itself ships in 20260911061450_audit_20260911_series_display_label_states_its_anon_exec_decision.
-- (Marker line appended to this stored migration on 2026-09-11 so migration-autorecover's gate can commit the file; the SQL below is byte-for-byte what executed.)
-- Follow-up to audit_20260911_series_label_carries_the_word_series…
--
-- ⚠ THE SEASON FALLBACK WAS TOO WIDE. It existed only for Disney Pinnacle,
-- whose editions carry the YEAR (2024) where collection_series keys on an
-- ordinal (2) and parks the year in `season`. Left un-scoped it also matched
-- NFL All Day, whose series 7 and 8 both carry season '2024' — so a series
-- value of 2024 on an All Day edition answered "Series 7". No All Day edition
-- carries 2024 today, so nothing rendered wrong; this closes the latent answer
-- before some future ingest makes it reachable.
CREATE OR REPLACE FUNCTION public.series_display_label(p_collection_id uuid, p_series int)
 RETURNS text
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $fn$
DECLARE
  v_label  text;
  v_season text;
  v_slug   text;
BEGIN
  IF p_series IS NULL THEN RETURN NULL; END IF;

  SELECT c.slug INTO v_slug FROM public.collections c WHERE c.id = p_collection_id;

  SELECT cs.display_label, cs.season INTO v_label, v_season
  FROM public.collection_series cs
  WHERE cs.collection_id = p_collection_id
    AND (
      cs.series_number = p_series
      OR (v_slug = 'disney_pinnacle' AND cs.season = p_series::text)
    )
  ORDER BY (cs.series_number = p_series) DESC
  LIMIT 1;

  -- Top Shot retired the ordinal after Series 4. The repo map and
  -- collection_series disagree on the ORDINAL for on-chain 6/7/8 (open — see
  -- CLAUDE.md) but AGREE on the season, so the season form is the answer that
  -- does not take a side, and it reproduces lib/series-label.ts exactly.
  IF v_slug = 'nba_top_shot' AND p_series >= 6 AND v_season IS NOT NULL THEN
    RETURN 'Series ' || v_season;
  END IF;

  IF v_label IS NULL OR btrim(v_label) = '' THEN
    RETURN 'Series ' || p_series::text;
  END IF;

  IF v_label ~ '^[0-9]' THEN
    RETURN 'Series ' || v_label;
  END IF;

  RETURN v_label;
END;
$fn$;

-- REVERT: re-run the previous migration's definition of this function.