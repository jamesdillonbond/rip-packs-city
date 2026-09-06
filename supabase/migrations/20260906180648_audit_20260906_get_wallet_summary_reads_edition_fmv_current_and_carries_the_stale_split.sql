-- audit_20260906_get_wallet_summary_reads_edition_fmv_current_and_carries_the_stale_split
--
-- get_wallet_summary(p_wallet, p_collection_id) feeds the Collection tab's four
-- headline tiles (WALLET FMV / UNLOCKED / LOCKED / BEST OFFER). Two things
-- measured 2026-09-06 on the founder's wallet, signed in, real Chromium:
--
--   1. It is the fourth surface to headline the SAME wallet at a DIFFERENT
--      number: Collection tab $87,812 (raw, stale included, no caption) vs
--      dashboard $50,234 + $44,039 stale vs /share $50,223 + $42,729 stale.
--      The 2026-09-03/04 rule is headline = total − stale, stale disclosed.
--      This RPC had no stale split to disclose.
--   2. Its per-moment `ORDER BY computed_at DESC LIMIT 1` lateral over
--      fmv_snapshots costs 202,057 buffers / 1.33 s per call — the same
--      shape retired from get_collection_stats an hour earlier.
--
-- Both fixed by reading `edition_fmv_current` (latest-per-edition, maintained)
-- and adding `stale_fmv` / `stale_count` (confidence = 'STALE', the headline's
-- own test) to the payload. All existing keys keep their meaning; the wallet_fmv
-- stays the raw sum so the client can render total − stale exactly like the
-- dashboard. Guarded splice on the live body (md5 asserted).
--
-- Revert: body by md5 f3913eba7c0b4ef2df00094824e78a9c in schema_migrations.

DO $splice$
DECLARE v_oid oid; v_def text; v_old text; v_new text; v_n int;
BEGIN
  SELECT p.oid INTO v_oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'get_wallet_summary';
  IF v_oid IS NULL THEN RAISE EXCEPTION 'get_wallet_summary missing'; END IF;
  IF md5((SELECT prosrc FROM pg_proc WHERE oid = v_oid)) <> 'f3913eba7c0b4ef2df00094824e78a9c' THEN
    RAISE EXCEPTION 'get_wallet_summary drifted (md5 %)', md5((SELECT prosrc FROM pg_proc WHERE oid = v_oid));
  END IF;
  v_def := pg_get_functiondef(v_oid);

  v_old := E'      wmc.is_locked,\n      lf.fmv_usd,\n';
  v_new := E'      wmc.is_locked,\n      lf.fmv_usd,\n      lf.confidence,\n';
  v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_n <> 1 THEN RAISE EXCEPTION 'anchor 1 count %', v_n; END IF;
  v_def := replace(v_def, v_old, v_new);

  v_old := E'    LEFT JOIN LATERAL (\n'
        || E'      SELECT fs.fmv_usd FROM fmv_snapshots fs\n'
        || E'      WHERE fs.edition_id = e.id ORDER BY fs.computed_at DESC LIMIT 1\n'
        || E'    ) lf ON true\n';
  v_new := E'    -- 2026-09-06: latest-per-edition lives in edition_fmv_current (202K buffers → index probes)\n'
        || E'    LEFT JOIN edition_fmv_current lf ON lf.edition_id = e.id\n';
  v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_n <> 1 THEN RAISE EXCEPTION 'anchor 2 count %', v_n; END IF;
  v_def := replace(v_def, v_old, v_new);

  v_old := E'    ''locked_count'', (SELECT COUNT(*) FROM moment_data WHERE is_locked),\n';
  v_new := E'    -- 2026-09-06: the stale split, so the Collection tab can headline total − stale like every other surface\n'
        || E'    ''stale_fmv'', (SELECT ROUND(COALESCE(SUM(CASE WHEN confidence = ''STALE'' THEN fmv_usd ELSE 0 END), 0)::numeric, 2) FROM moment_data),\n'
        || E'    ''stale_count'', (SELECT COUNT(*) FROM moment_data WHERE confidence = ''STALE''),\n'
        || E'    ''locked_count'', (SELECT COUNT(*) FROM moment_data WHERE is_locked),\n';
  v_n := (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old);
  IF v_n <> 1 THEN RAISE EXCEPTION 'anchor 3 count %', v_n; END IF;
  v_def := replace(v_def, v_old, v_new);

  IF position('fmv_snapshots' IN v_def) > 0 THEN RAISE EXCEPTION 'post-condition: fmv_snapshots lateral survived'; END IF;
  IF position('''stale_fmv''' IN v_def) = 0 THEN RAISE EXCEPTION 'post-condition: stale_fmv missing'; END IF;
  EXECUTE v_def;
END
$splice$;

-- Post-flight on the founder's Top Shot wallet: same totals as before within FMV
-- drift, stale split present, and under the route's 8 s bound.
DO $verify$
DECLARE v json; v_t0 timestamptz; v_ms numeric;
BEGIN
  v_t0 := clock_timestamp();
  v := public.get_wallet_summary('0xbd94cade097e50ac', '95f28a17-224a-4025-96ad-adf8a4c63bfd');
  v_ms := extract(epoch from (clock_timestamp() - v_t0)) * 1000;
  RAISE NOTICE 'ms % total % wallet_fmv % stale_fmv % stale_count % locked %', round(v_ms), v->>'total_moments', v->>'wallet_fmv', v->>'stale_fmv', v->>'stale_count', v->>'locked_count';
  IF (v->>'total_moments')::int < 15000 THEN RAISE EXCEPTION 'total_moments % (expected ~15,290)', v->>'total_moments'; END IF;
  IF (v->>'wallet_fmv')::numeric < 80000 OR (v->>'wallet_fmv')::numeric > 95000 THEN RAISE EXCEPTION 'wallet_fmv % outside the 87.7K ± drift band', v->>'wallet_fmv'; END IF;
  -- (first draft demanded >= 200 from the dashboard's 315 — that figure is ALL collections; the
  -- public profile's per-collection breakdown reads Top Shot stale as 93. Bound to what it measures.)
  IF (v->>'stale_count')::int < 50 THEN RAISE EXCEPTION 'stale_count % (profile breakdown reads 93 for Top Shot)', v->>'stale_count'; END IF;
  IF v_ms > 8000 THEN RAISE EXCEPTION 'still % ms', round(v_ms); END IF;
END
$verify$;
