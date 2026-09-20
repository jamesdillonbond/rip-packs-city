-- Candy MLB joins the two market-pulse RPCs (2026-09-20 ~10:50 AM PT, Claude Code cloud).
--
-- WHAT WAS MISSING. Both functions carry a hardcoded FOUR-slug IN-list, and
-- `get_market_pulse_windows` additionally carries a hardcoded five-row
-- `cols(slug, collection_name)` VALUES list. Candy was in neither, so it was
-- absent from THREE surfaces at once:
--   * the homepage / overview 24 h stats (`/api/overview-stats`)
--   * the PUBLIC Market Pulse board (`/insights/market-pulse`)
--   * the email digest (`/api/send-digest`)
--
-- 🚨 AND THE ABSENCE WAS NOT RENDERED AS AN ABSENCE. `getVolume24hFromPulse`
-- in app/api/overview-stats/route.ts does
--     `rows.find(r => r.slug === dbSlug)` … `Number(hit?.volume_24h ?? 0)`
-- so a MISSING ROW becomes a measured-looking **$0** — the `?? 0` fabricated-value
-- shape CLAUDE.md bans, pointed at a collection that traded 129 times in the last
-- 24 hours. Fixing the RPCs fixes it at the source. ⚠ The `?? 0` itself is still
-- latent for any future collection that is absent from the pulse; that is a route
-- change, not this migration.
--
-- ⚠ PINNACLE WAS NEVER EXCLUDED, and an earlier note of mine said it was: both
-- functions give Pinnacle its OWN union arm off `pinnacle_sales`, because its
-- sales do not live in `sales`. Only Candy was missing. Re-derived from the
-- bodies before writing this.
--
-- WHY A GATED STRING REPLACEMENT RATHER THAN TWO TRANSCRIBED BODIES: these are
-- 1.3 kB and 4.8 kB of SQL whose only change is one list member each. Re-typing
-- them is pure transcription risk for no benefit. So this migration gates on the
-- md5 of each live body, ASSERTS THE OCCURRENCE COUNT IS EXACTLY 1 before each
-- replace (a silent no-op replace is the failure mode), applies, and then
-- re-reads the catalog to confirm both functions name `candy_mlb` and that the
-- windows function carries the display name. All four checks are in the same
-- transaction as the write.
--
-- MEASURED, before → after (slug list from the live function):
--   before: nba_top_shot, disney_pinnacle, nfl_all_day, laliga_golazos, ufc_strike
--   after : …the same five, plus candy_mlb
-- Candy's live row on the public board (verified through the production caller at
-- 10:50 AM PT): 129 sales / $181.47 in 24 h, 270 / $1,235.54 in 7 d,
-- 1,554 / $7,048.93 in 30 d, top sales $19.31 / $103.01 / $203.72, named
-- "Candy MLB", ranked 4th of 6 by 7-day volume. The other five rows are
-- unchanged — the edit is additive by construction (one IN-list member, one
-- VALUES row), which is what the occurrence-count assertions pin.
--
-- ⭐ NO FRONTEND CHANGE WAS NEEDED and that is worth recording: the board client
-- already resolves its slug through the REGISTRY (`fromDbSlug(r.slug)` in
-- MarketPulseClient.tsx), so a sixth row renders with the right link and label on
-- its own. That is the derived-not-listed pattern paying off.
--
-- anon-exec: intentional - SNAPSHOT migration; CREATE OR REPLACE does not reset a function ACL, so a REVOKE here would smuggle a production ACL change into a body rewrite. public.get_market_pulse_all and public.get_market_pulse_windows are both already service_role-only and stay that way - VERIFIED with has_function_privilege (not acl text): anon EXECUTE false, authenticated EXECUTE false, service_role EXECUTE true for each.
--
-- REVERT: re-apply each body with the four-slug IN-list and the five-row cols
-- VALUES list. Prior md5s: get_market_pulse_all a9922969074d59a2abf4a9ef2a6832c9,
-- get_market_pulse_windows 5940a45f2a820d77d276e4b70358e2bd. Reverting drops
-- Candy from the public board and restores the fabricated $0 on its overview.

DO $mig$
DECLARE
  d text;
  n int;
  c_all_md5  constant text := 'a9922969074d59a2abf4a9ef2a6832c9';
  c_win_md5  constant text := '5940a45f2a820d77d276e4b70358e2bd';
  old_in     constant text := $ol$IN ('nba_top_shot','nfl_all_day','laliga_golazos','ufc_strike')$ol$;
  new_in     constant text := $nw$IN ('nba_top_shot','nfl_all_day','laliga_golazos','ufc_strike','candy_mlb')$nw$;
  old_cols   constant text := $oc$('laliga_golazos','LaLiga Golazos'),('ufc_strike','UFC Strike')$oc$;
  new_cols   constant text := $nc$('laliga_golazos','LaLiga Golazos'),('ufc_strike','UFC Strike'),('candy_mlb','Candy MLB')$nc$;
BEGIN
  -- ── get_market_pulse_all ──────────────────────────────────────────────────
  IF (SELECT md5(p.prosrc) FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
      WHERE ns.nspname = 'public' AND p.proname = 'get_market_pulse_all')
     IS DISTINCT FROM c_all_md5 THEN
    RAISE EXCEPTION 'get_market_pulse_all changed since drafting (expected md5 %)', c_all_md5;
  END IF;

  d := pg_get_functiondef('public.get_market_pulse_all()'::regprocedure);
  n := (length(d) - length(replace(d, old_in, ''))) / length(old_in);
  IF n <> 1 THEN
    RAISE EXCEPTION 'get_market_pulse_all: expected exactly 1 occurrence of the slug IN-list, found %', n;
  END IF;
  EXECUTE replace(d, old_in, new_in);

  -- ── get_market_pulse_windows ──────────────────────────────────────────────
  IF (SELECT md5(p.prosrc) FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
      WHERE ns.nspname = 'public' AND p.proname = 'get_market_pulse_windows')
     IS DISTINCT FROM c_win_md5 THEN
    RAISE EXCEPTION 'get_market_pulse_windows changed since drafting (expected md5 %)', c_win_md5;
  END IF;

  d := pg_get_functiondef('public.get_market_pulse_windows()'::regprocedure);
  n := (length(d) - length(replace(d, old_in, ''))) / length(old_in);
  IF n <> 1 THEN
    RAISE EXCEPTION 'get_market_pulse_windows: expected exactly 1 occurrence of the slug IN-list, found %', n;
  END IF;
  n := (length(d) - length(replace(d, old_cols, ''))) / length(old_cols);
  IF n <> 1 THEN
    RAISE EXCEPTION 'get_market_pulse_windows: expected exactly 1 occurrence of the cols VALUES tail, found %', n;
  END IF;
  EXECUTE replace(replace(d, old_in, new_in), old_cols, new_cols);

  -- ── post-flight, in the same transaction as the write ─────────────────────
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
      WHERE ns.nspname = 'public'
        AND p.proname IN ('get_market_pulse_all','get_market_pulse_windows')
        AND p.prosrc LIKE '%candy_mlb%') <> 2 THEN
    RAISE EXCEPTION 'post-flight: both market-pulse functions should now name candy_mlb';
  END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
      WHERE ns.nspname = 'public' AND p.proname = 'get_market_pulse_windows'
        AND p.prosrc LIKE '%Candy MLB%') <> 1 THEN
    RAISE EXCEPTION 'post-flight: get_market_pulse_windows should carry the Candy MLB display name';
  END IF;
END
$mig$;
