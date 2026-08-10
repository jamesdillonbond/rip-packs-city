-- deep-audit D3, continued. The Top Shot fix (previous migration) applies
-- identically to the other four Set Tracker functions — All Day's tracker was
-- ALSO timing out (verified live: get_allday_set_progress exceeded its own cap
-- for Trevor's wallet), which the audit never caught because its rendered-DOM
-- pass never covered the All Day tabs (a documented coverage gap in the handoff).
--
-- All four carried the same non-sargable predicate:
--     lower(wmc.wallet_address) = lower(p_wallet)
-- Wrapping the COLUMN in lower() means no wallet_address index can serve it, so
-- the planner inverts the join and probes the 2.2M-row wallet_moments_cache once
-- per catalogue edition, applying the wallet as a post-index filter.
--
-- Safety (verified live 2026-08-09): across all 2,211,030 wmc rows the ONLY
-- non-lowercase wallet_address values are the 25,375 candy_mlb rows — Solana
-- base58 is case-sensitive by design. Every Flow collection is 0, and these four
-- functions are Flow-only (Top Shot / All Day / UFC catalogues). lower() stays on
-- the PARAMETER, so a caller passing mixed case still matches.
--
-- The rewrite replays each function's own pg_get_functiondef with one literal
-- substitution rather than re-transcribing four large bodies by hand — the
-- substitution cannot introduce a transcription error, and everything else in
-- each body is preserved byte-for-byte. Each function is asserted to have
-- actually changed, so a silent no-op fails the migration instead of passing.
--
-- Verified after apply: 0 of the 5 set functions still match
-- lower(wmc.wallet_address); get_allday_set_progress returns 363 sets / 95
-- complete, get_ufc_set_progress 256 sets (both match analytics_sets_summary),
-- get_topshot_set_detail 22 owned on the first set.
--
-- Revert: replay each definition substituting the predicate back to
-- `lower(wmc.wallet_address) = lower(p_wallet)`.

DO $do$
DECLARE
  fn text;
  def text;
  newdef text;
  target text[] := ARRAY[
    'get_topshot_set_detail',
    'get_allday_set_progress',
    'get_allday_set_detail',
    'get_ufc_set_progress'
  ];
BEGIN
  FOREACH fn IN ARRAY target LOOP
    SELECT pg_get_functiondef(p.oid) INTO def
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = fn
    LIMIT 1;

    IF def IS NULL THEN
      RAISE EXCEPTION 'function public.% not found', fn;
    END IF;

    newdef := replace(
      def,
      'lower(wmc.wallet_address) = lower(p_wallet)',
      'wmc.wallet_address = lower(p_wallet)'
    );

    -- Idempotent re-run: if the predicate is already sargable there is nothing
    -- to do. Only raise when the function is missing the expected shape AND has
    -- not already been rewritten.
    IF newdef = def THEN
      IF def ~* 'wmc\.wallet_address = lower\(p_wallet\)' THEN
        RAISE NOTICE 'public.% already sargable, skipping', fn;
        CONTINUE;
      END IF;
      RAISE EXCEPTION
        'public.% did not contain the expected predicate — refusing to pass silently', fn;
    END IF;

    EXECUTE newdef;
    RAISE NOTICE 'rewrote %', fn;
  END LOOP;
END
$do$;
