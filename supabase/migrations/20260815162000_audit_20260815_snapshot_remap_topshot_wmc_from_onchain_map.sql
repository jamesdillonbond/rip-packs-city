-- Snapshot migration: public.remap_topshot_wmc_from_onchain_map().
--
-- MCP-applied to prod with no committed migration → UNPINNABLE. This commits the
-- CURRENT LIVE body verbatim (pg_get_functiondef 2026-08-15) so it can carry a
-- drift-guarded pinned test. Applying it is a no-op vs prod (byte-identical), so
-- it is committed UNAPPLIED — every apply_migration costs a ~10-20s burst of
-- user-facing PGRST002 500s and this one would buy nothing.
--
-- Re-keys FOSSIL wallet_moments_cache rows — rows whose edition_key is not in the
-- canonical `setID:playID[::subID]` form — onto the real edition, using the
-- on-chain map as the authority. wmc is the portfolio store (~34 DB functions sum
-- wmc.fmv_usd), and CLAUDE.md records that wmc UUID fossils render as real moments
-- on /share and wallet snapshots, so a bad re-key here is directly user-visible.
--
-- Four properties worth pinning:
--
--   • PARALLEL WINS OVER BASE. new_key is COALESCE(epar, ebase): when the moment
--     has a subedition_id > 0 and the parallel edition exists, the row keys to the
--     parallel. Collapsing that to the base is the exact parallel-conflation
--     defect this whole program exists to fix.
--   • UNRESOLVED IS COUNTED, NOT GUESSED. A row with no resolvable edition has
--     new_key IS NULL; it is reported in `unresolved_no_edition` and left alone
--     rather than written to some fallback.
--   • THE AUDIT ROW AND THE UPDATE SHARE ONE PREDICATE. Both require
--     `new_key IS NOT NULL AND new_key <> old_key`, so the audit table is a
--     faithful record of what changed — it is the revert path.
--   • THE STUB LOOP IS PER-ROW GUARDED. `EXCEPTION WHEN OTHERS THEN NULL` means
--     one un-stubbable moment cannot abort the batch. Note the deliberate
--     consequence: failures are swallowed silently and only visible as a smaller
--     `editions_stubbed` count.
--
-- Pinned by supabase/tests/remap_topshot_wmc_from_onchain_map.sql.

CREATE OR REPLACE FUNCTION public.remap_topshot_wmc_from_onchain_map()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '300s'
AS $function$
DECLARE
  v_ts uuid := '95f28a17-224a-4025-96ad-adf8a4c63bfd';
  v_wmc int := 0;
  v_stubbed int := 0;
  v_unresolved int := 0;
  r record;
BEGIN
  -- Ensure a canonical base edition exists for every mapped nft that keys a
  -- fossil row but has no set:play edition yet. Per-row guarded so one failure
  -- can't abort the batch.
  FOR r IN
    SELECT DISTINCT m.set_id_onchain, m.play_id_onchain
    FROM topshot_misattrib_onchain_map m
    WHERE EXISTS (
            SELECT 1 FROM wallet_moments_cache w
            WHERE w.collection_id = v_ts AND w.moment_id::text = m.nft_id::text
              AND w.edition_key !~ '^[0-9]+:[0-9]+(::[0-9]+)?$')
      AND NOT EXISTS (
            SELECT 1 FROM editions e
            WHERE e.collection_id = v_ts
              AND e.external_id = (m.set_id_onchain::text || ':' || m.play_id_onchain::text))
  LOOP
    BEGIN
      PERFORM ensure_topshot_edition_stub(r.set_id_onchain, r.play_id_onchain);
      v_stubbed := v_stubbed + 1;
    EXCEPTION WHEN OTHERS THEN
      NULL;
    END;
  END LOOP;

  DROP TABLE IF EXISTS _wtgt;
  CREATE TEMP TABLE _wtgt ON COMMIT DROP AS
  SELECT w.wallet_address, w.collection_id, w.moment_id,
         w.edition_key AS old_key, w.serial_number AS old_serial,
         m.serial_number AS map_serial,
         COALESCE(epar.external_id, ebase.external_id) AS new_key
  FROM wallet_moments_cache w
  JOIN topshot_misattrib_onchain_map m ON m.nft_id::text = w.moment_id::text
  LEFT JOIN topshot_moment_subeditions sub
         ON sub.nft_id = m.nft_id AND COALESCE(sub.subedition_id,0) > 0
  LEFT JOIN editions ebase
         ON ebase.collection_id = v_ts
        AND ebase.external_id = (m.set_id_onchain::text || ':' || m.play_id_onchain::text)
  LEFT JOIN editions epar
         ON sub.subedition_id IS NOT NULL AND epar.collection_id = v_ts
        AND epar.external_id = (m.set_id_onchain::text || ':' || m.play_id_onchain::text || '::' || sub.subedition_id::text)
  WHERE w.collection_id = v_ts
    AND w.edition_key !~ '^[0-9]+:[0-9]+(::[0-9]+)?$';

  SELECT count(*) INTO v_unresolved FROM _wtgt WHERE new_key IS NULL;

  INSERT INTO audit_20260627_wmc_fossil_onchain_remap
    (wallet_address, collection_id, moment_id, old_edition_key, old_serial, new_edition_key, new_serial)
  SELECT wallet_address, collection_id, moment_id::text, old_key, old_serial, new_key, COALESCE(map_serial, old_serial)
  FROM _wtgt
  WHERE new_key IS NOT NULL AND new_key <> old_key;

  UPDATE wallet_moments_cache w
  SET edition_key = t.new_key,
      serial_number = COALESCE(t.map_serial, w.serial_number)
  FROM _wtgt t
  WHERE w.wallet_address = t.wallet_address
    AND w.collection_id = t.collection_id
    AND w.moment_id = t.moment_id
    AND t.new_key IS NOT NULL AND t.new_key <> t.old_key;
  GET DIAGNOSTICS v_wmc = ROW_COUNT;

  RETURN jsonb_build_object(
    'wmc_rekeyed', v_wmc,
    'editions_stubbed', v_stubbed,
    'unresolved_no_edition', v_unresolved,
    'map_size', (SELECT count(*) FROM topshot_misattrib_onchain_map)
  );
END $function$;
