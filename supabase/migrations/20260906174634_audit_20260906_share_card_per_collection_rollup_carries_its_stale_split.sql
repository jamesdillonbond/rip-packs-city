-- audit_20260906_share_card_per_collection_rollup_carries_its_stale_split
--
-- /share/<wallet> — the front door's first screen for a new collector — headlines
-- "total − stale" (2026-09-04, shareHeadline()) but its "Across Flow Collections"
-- row still printed the RAW per-collection sum. Measured 2026-09-06 on the
-- founder's wallet, signed out: headline $50,222.99 "+ $42,729 across 315
-- stale-priced moments", and two screens down NBA TOP SHOT $87,785 — the same
-- wallet, the same card, two bases. This is the 2026-09-03 "breakdown 2× the
-- headline" shape on the surface that decides whether a visitor signs up.
--
-- Fix at the source: get_wallet_collection_snapshot's per_coll rollup now
-- carries stale_fmv / stale_count per collection (same STALE test as the
-- headline's `stale` CTE), so the page can render total − stale with the
-- "+ $X stale" caption on every tile. Guarded splice on the live body.
--
-- Revert: body by md5 4f272caf3ddb35b4e97ad96954c74fd3 (schema_migrations).

DO $splice$
DECLARE
  v_oid oid; v_def text; v_old text; v_new text; v_n int;
BEGIN
  SELECT p.oid INTO v_oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_wallet_collection_snapshot';
  IF v_oid IS NULL THEN RAISE EXCEPTION 'get_wallet_collection_snapshot missing'; END IF;
  IF md5((SELECT prosrc FROM pg_proc WHERE oid = v_oid)) <> '4f272caf3ddb35b4e97ad96954c74fd3' THEN
    RAISE EXCEPTION 'get_wallet_collection_snapshot drifted (md5 %)', md5((SELECT prosrc FROM pg_proc WHERE oid = v_oid));
  END IF;
  v_def := pg_get_functiondef(v_oid);

  v_old := E'               ''fmv'', round(COALESCE(sum(w.fmv_usd), 0)::numeric, 2),\n'
        || E'               ''market_closed_at'', c.market_closed_at\n'
        || E'             ) AS pc\n'
        || E'      FROM w JOIN collections c ON c.id = w.collection_id\n'
        || E'      GROUP BY c.slug, c.name, c.market_closed_at\n';
  v_new := E'               ''fmv'', round(COALESCE(sum(w.fmv_usd), 0)::numeric, 2),\n'
        || E'               -- 2026-09-06: same basis as the headline (total − stale). The card\n'
        || E'               -- printed NBA Top Shot $87,785 raw beside a $50,223 headline.\n'
        || E'               ''stale_fmv'', round(COALESCE(sum(w.fmv_usd) FILTER (WHERE l.confidence = ''STALE''), 0)::numeric, 2),\n'
        || E'               ''stale_count'', count(*) FILTER (WHERE l.confidence = ''STALE''),\n'
        || E'               ''market_closed_at'', c.market_closed_at\n'
        || E'             ) AS pc\n'
        || E'      FROM w JOIN collections c ON c.id = w.collection_id\n'
        || E'      LEFT JOIN LATERAL (\n'
        || E'        SELECT l.confidence FROM editions e JOIN edition_fmv_current l ON l.edition_id = e.id\n'
        || E'         WHERE e.external_id = w.edition_key AND e.collection_id = w.collection_id LIMIT 1\n'
        || E'      ) l ON true\n'
        || E'      GROUP BY c.slug, c.name, c.market_closed_at\n';
  v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_n <> 1 THEN RAISE EXCEPTION 'per_coll anchor count % (expected 1)', v_n; END IF;
  v_def := replace(v_def, v_old, v_new);
  IF position('''stale_fmv''' IN v_def) = 0 THEN RAISE EXCEPTION 'post-condition failed'; END IF;
  EXECUTE v_def;
END
$splice$;

-- Post-flight on the founder's wallet: the sum of per-collection stale must
-- equal the headline stale for open markets (same population, same test).
DO $verify$
DECLARE v jsonb; v_sum numeric; v_head numeric;
BEGIN
  v := public.get_wallet_collection_snapshot('0xbd94cade097e50ac');
  SELECT COALESCE(sum((x->>'stale_fmv')::numeric), 0) INTO v_sum
    FROM jsonb_array_elements(v->'perCollection') x
   WHERE x->>'market_closed_at' IS NULL;
  v_head := (v->>'staleFmv')::numeric;
  RAISE NOTICE 'per-collection stale sum % vs headline stale %', v_sum, v_head;
  IF abs(v_sum - v_head) > 1 THEN RAISE EXCEPTION 'stale split disagrees: % vs %', v_sum, v_head; END IF;
END
$verify$;
