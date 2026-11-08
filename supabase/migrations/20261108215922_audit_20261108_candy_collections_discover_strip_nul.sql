-- audit_20261108_candy_collections_discover_strip_nul
--
-- Fix for 20261108215733: the first discovery collect parsed 0 of 401 collections
-- (`unparsed: 401`, logged ok:false, inventory untouched — the fail-closed path worked).
-- Cause: `replace(…, chr(0), '')` — chr(0) itself raises 54000 "null character not
-- permitted", so every row hit the per-row handler. NUL bytes are now dropped at the BYTEA
-- level (candy_strip_nul) before convert_from, and the first per-row error is now carried
-- into the run's error / extra (a count of 401 unparsed said nothing about WHY).
--
-- anon-exec: intentional — candy_strip_nul is new and REVOKEd below; candy_collections_discover_collect keeps its signature and ACL (service_role only)
--
-- Rollback: re-apply candy_collections_discover_collect from 20261108215733; DROP FUNCTION public.candy_strip_nul(bytea);

CREATE OR REPLACE FUNCTION public.candy_strip_nul(p bytea)
RETURNS bytea
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public
AS $$
DECLARE i int;
BEGIN
  LOOP
    i := position('\x00'::bytea in p);
    EXIT WHEN i = 0;
    p := overlay(p placing ''::bytea from i for 1);
  END LOOP;
  RETURN p;
END
$$;
REVOKE ALL ON FUNCTION public.candy_strip_nul(bytea) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.candy_strip_nul(bytea) TO service_role;

-- when-others-timeout-blind: intentional — its only handler is the per-row parse guard
-- inside the account LOOP; see the comment at that handler.
CREATE OR REPLACE FUNCTION public.candy_collections_discover_collect()
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_req  record;
  v_resp record;
  v_body jsonb;
  v_acc  jsonb;
  v_data bytea;
  v_nl int; v_ul int; v_o int;
  v_name text; v_uri text; v_minted bigint; v_size bigint;
  v_addr text; v_kind text; v_prefix text; v_set uuid;
  v_seen int := 0; v_new int := 0; v_bad int := 0;
  v_started timestamptz := clock_timestamp();
  v_err text := null;
  v_first_bad text := null;
BEGIN
  SELECT * INTO v_req FROM candy_collections_discover_requests
   WHERE collected_at IS NULL ORDER BY requested_at DESC LIMIT 1;
  IF v_req IS NULL THEN
    v_err := 'no pending request';
  ELSE
    SELECT * INTO v_resp FROM net._http_response WHERE id = v_req.request_id;
    IF v_resp IS NULL THEN
      v_err := 'response not arrived (request ' || v_req.request_id || ')';
    ELSIF v_resp.status_code IS DISTINCT FROM 200 THEN
      v_err := 'HTTP ' || coalesce(v_resp.status_code::text, 'null') || ': ' || left(coalesce(v_resp.error_msg, v_resp.content, ''), 200);
    ELSE
      v_body := v_resp.content::jsonb;
      IF v_body ? 'error' OR jsonb_typeof(v_body->'result') IS DISTINCT FROM 'array' THEN
        v_err := 'rpc error: ' || left(coalesce(v_body->>'error', v_resp.content), 200);
      ELSIF jsonb_array_length(v_body->'result') = 0 THEN
        v_err := 'empty result — inventory left unchanged';
      ELSE
        FOR v_acc IN SELECT * FROM jsonb_array_elements(v_body->'result') LOOP
          BEGIN
            v_addr := v_acc->>'pubkey';
            v_data := decode(v_acc->'account'->'data'->>0, 'base64');
            v_nl := get_byte(v_data,33) + (get_byte(v_data,34) << 8) + (get_byte(v_data,35) << 16) + (get_byte(v_data,36) << 24);
            v_name := btrim(convert_from(public.candy_strip_nul(substring(v_data from 38 for v_nl)), 'UTF8'));
            v_o := 37 + v_nl;
            v_ul := get_byte(v_data,v_o) + (get_byte(v_data,v_o+1) << 8) + (get_byte(v_data,v_o+2) << 16) + (get_byte(v_data,v_o+3) << 24);
            v_uri := convert_from(public.candy_strip_nul(substring(v_data from v_o + 5 for v_ul)), 'UTF8');
            v_o := v_o + 4 + v_ul;
            v_minted := get_byte(v_data,v_o) + (get_byte(v_data,v_o+1) << 8) + (get_byte(v_data,v_o+2) << 16) + (get_byte(v_data,v_o+3)::bigint << 24);
            v_size := get_byte(v_data,v_o+4) + (get_byte(v_data,v_o+5) << 8) + (get_byte(v_data,v_o+6) << 16) + (get_byte(v_data,v_o+7)::bigint << 24);
            v_seen := v_seen + 1;
            IF EXISTS (SELECT 1 FROM candy_collections WHERE address = v_addr) THEN
              UPDATE candy_collections SET name = v_name, uri = v_uri, num_minted = v_minted, current_size = v_size, refreshed_at = now()
               WHERE address = v_addr;
            ELSE
              v_kind := CASE
                WHEN v_name ~* '\m(test|prototype)\M' THEN 'test'
                WHEN v_name ~* '(football|nascar)' THEN 'other'
                WHEN v_name ~* '(MLB|ICONs?\M|All-Star|Leadoff|Play of the Day|Plays of the Week|Hall of Fame|Uncut Diamond|Digi-Cast|Opening Day|World Series|Team Ball|Rookie|\mBase [12]\M|\mGems\M|Tickets|Showstopper|Jersey|Baseball|Starting 9|Tokyo Series|Speedway|Tricons|Candy Celebratory|ICON Chasers|Code Breaker)' THEN 'mlb'
                ELSE 'other' END;
              v_prefix := NULL; v_set := NULL;
              IF v_kind <> 'test' THEN
                v_prefix := 'c:' || coalesce(nullif(btrim(left(regexp_replace(regexp_replace(lower(v_name), '[^a-z0-9]+', '-', 'g'), '-+', '-', 'g'), 48), '-'), ''), left(v_addr, 8));
                IF EXISTS (SELECT 1 FROM candy_collections WHERE edition_prefix = v_prefix) THEN
                  v_prefix := v_prefix || '-' || lower(left(v_addr, 4));
                END IF;
                v_set := extensions.uuid_generate_v5(extensions.uuid_ns_url(), 'candy-collection:' || v_addr);
                INSERT INTO sets (id, external_id, collection_id, name, series)
                VALUES (v_set, 'candy-coll-' || v_addr, '209ade70-32c5-4470-bc7c-4793d660f713'::uuid, v_name, NULL)
                ON CONFLICT (id) DO NOTHING;
              END IF;
              INSERT INTO candy_collections (address, name, uri, num_minted, current_size, kind, set_id, edition_prefix)
              VALUES (v_addr, v_name, v_uri, v_minted, v_size, v_kind, v_set, v_prefix);
              v_new := v_new + 1;
            END IF;
          -- when-others-timeout-blind: intentional — a per-row parse guard inside the account
          -- loop (a malformed account is counted and named, the rest still load). A 57014 kill
          -- aborts the whole collect: nothing is committed, no run row is written, and the next
          -- day's begin/collect pair retries; a timeout must not be recorded as "unparsed".
          EXCEPTION WHEN OTHERS THEN
            v_bad := v_bad + 1;
            IF v_first_bad IS NULL THEN v_first_bad := left(coalesce(v_addr, '?') || ': ' || SQLERRM, 200); END IF;
          END;
        END LOOP;
      END IF;
    END IF;
    UPDATE candy_collections_discover_requests SET collected_at = now() WHERE request_id = v_req.request_id
      AND (v_err IS NULL OR v_err NOT LIKE 'response not arrived%');
  END IF;
  PERFORM log_pipeline_run('candy-collections-discover', v_started, v_seen, v_new, v_bad, v_err IS NULL AND v_bad = 0, coalesce(v_err, CASE WHEN v_bad > 0 THEN v_bad || ' unparsed; first: ' || v_first_bad END),
    'candy_mlb', NULL::text, NULL::text, jsonb_build_object('seen', v_seen, 'new', v_new, 'unparsed', v_bad, 'first_unparsed', v_first_bad));
  RETURN jsonb_build_object('seen', v_seen, 'new', v_new, 'unparsed', v_bad, 'first_unparsed', v_first_bad, 'error', v_err);
END
$$;

