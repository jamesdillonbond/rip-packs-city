-- definer-view: intentional — pack_table_rows was already a definer view (reloptions NULL) and is listed in
--   security_definer_view_allowlist; CREATE OR REPLACE keeps that unchanged (read back 10-19 after apply).
-- pack_table_rows: Pinnacle's depletion % gets an "as of" (pack-ev.md Next #4, still-open half).
--
-- The board showed "age unknown" on all 138 Pinnacle depletion figures because neither
-- supply_as_of nor depletion_as_of had a Pinnacle branch. pd.updated_at is not the age of the
-- read: pack_distributions has a second Pinnacle writer (metadata.source = 'pds_contract').
-- compute-pinnacle-pack-ev now stamps metadata.supply_as_of with the time it read Studio's
-- totalSupply/availableSupply, and only when both came back. This adds that branch to both
-- columns. Rows the writer has not yet re-stamped stay NULL ("age unknown"), as before.
-- The cast is gated on the ISO shape so one malformed value cannot fail the whole view.
--
-- REVERT: re-run this block with each *_new/*_old pair swapped.
DO $mig$
DECLARE
  v_def text;
  v_new text;
  pin_ts constant text := $x$CASE
                    WHEN (pd.metadata ->> 'supply_as_of'::text) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T'::text THEN (pd.metadata ->> 'supply_as_of'::text)::timestamp with time zone
                    ELSE NULL::timestamp with time zone
                END$x$;
  a1_old constant text := $x$THEN ads.opened_updated_at
            ELSE NULL::timestamp with time zone
        END AS supply_as_of$x$;
  a2_old constant text := $x$THEN ads.opened_updated_at
                ELSE NULL::timestamp with time zone
            END$x$;
  a1_new text;
  a2_new text;
BEGIN
  a1_new := $x$THEN ads.opened_updated_at
            WHEN pd.collection_id = '7dd9dd11-e8b6-45c4-ac99-71331f959714'::uuid THEN $x$ || pin_ts || $x$
            ELSE NULL::timestamp with time zone
        END AS supply_as_of$x$;
  a2_new := $x$THEN ads.opened_updated_at
                WHEN pd.collection_id = '7dd9dd11-e8b6-45c4-ac99-71331f959714'::uuid THEN $x$ || pin_ts || $x$
                ELSE NULL::timestamp with time zone
            END$x$;
  v_def := pg_get_viewdef('public.pack_table_rows'::regclass, true);
  v_new := v_def;
  IF (length(v_new) - length(replace(v_new, a1_old, ''))) / length(a1_old) <> 1 THEN RAISE EXCEPTION 'anchor a1 not unique'; END IF;
  v_new := replace(v_new, a1_old, a1_new);
  IF (length(v_new) - length(replace(v_new, a2_old, ''))) / length(a2_old) <> 1 THEN RAISE EXCEPTION 'anchor a2 not unique'; END IF;
  v_new := replace(v_new, a2_old, a2_new);
  EXECUTE 'CREATE OR REPLACE VIEW public.pack_table_rows AS ' || v_new;
END
$mig$;
