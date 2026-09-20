-- The `/api/analytics/sets/summary` payload asserted a coverage list that
-- EXCLUDED a collection it was returning in the same response
-- (2026-09-20 ~10:57 AM PT, Claude Code cloud).
--
-- `analytics_sets_summary` emits a `note` reading "Set-level metrics cover Top
-- Shot, All Day, Golazos, UFC Strike, and Disney Pinnacle." Measured live the
-- same minute, `analytics_sets_summary(ARRAY['candy_mlb'])` returns
-- `{"candy_mlb": {"set_count": 1, "edition_count": 125,
--   "tier_breakdown": {"common": 100, "legendary": 25}}}` — so the sentence
-- describing the payload's coverage is contradicted by the payload's own body.
--
-- ⚠ IT IS NOT RENDERED IN THE UI — `SetsDashboard` never reads `note`. It is
-- still worth correcting because this is a PUBLIC JSON endpoint (the analytics
-- API is documented at /analytics/api), so the only consumer that can read this
-- field is a consumer reading it as the authoritative coverage statement. A
-- caveat nobody renders is not thereby a caveat nobody believes.
--
-- The tier vocabulary added for Candy is MEASURED, not assumed: its
-- tier_breakdown keys are exactly `common` and `legendary` (100 / 25).
--
-- ⚠ Gated string replacement, not a transcribed body, for the same reason as
-- 20260920175000: 3.2 kB of SQL whose only change is one sentence. Gates on the
-- live md5, asserts the occurrence count is EXACTLY 1 before replacing (a silent
-- no-op replace is the failure mode), and re-reads the catalog afterwards — all
-- inside the transaction that writes.
--
-- anon-exec: intentional - SNAPSHOT migration; CREATE OR REPLACE does not reset a function ACL, so a REVOKE here would smuggle a production ACL change into a comment fix. public.analytics_sets_summary is already service_role-only and stays that way - VERIFIED with has_function_privilege (not acl text): anon EXECUTE false, authenticated EXECUTE false, service_role EXECUTE true.
--
-- REVERT: replace the note back. Prior md5 3e707d0339d982a716a9a3647bf68a83
-- (3,193 chars). Reverting restores a payload that denies covering a collection
-- it returns.
--
-- ⚠ FILENAME NOTE (2026-09-20, ~11:05 AM PT). This migration was applied via MCP
-- by one session, which committed it under a GUESSED version stamp
-- (…175800), while a concurrent session's `chore(db): recover MCP-applied
-- migration files` wrote the same body under the stamp production actually
-- RECORDED (…175533). Two files, one migration. The recovered stamp is the
-- authoritative one, so THIS file survives and the guessed-stamp duplicate was
-- deleted; the header below is the one the duplicate carried, moved here so the
-- reasoning is not lost with it. ⚠ `check-migration-parity` matches on NAME, so
-- a duplicate NAME is ambiguous to it rather than loud — worth knowing next time
-- an MCP-applied migration is committed by hand before the recovery runs.
--

DO $mig$
DECLARE
  d text;
  n int;
  c_md5   constant text := '3e707d0339d982a716a9a3647bf68a83';
  old_note constant text := $ol$Set-level metrics cover Top Shot, All Day, Golazos, UFC Strike, and Disney Pinnacle. tier_breakdown keys reflect the actual rarity scheme of each collection (Top Shot/All Day/Golazos use common/rare/legendary/ultimate, UFC uses challenger/contender/fandom, Pinnacle uses edition_type variants).$ol$;
  new_note constant text := $nw$Set-level metrics cover Top Shot, All Day, Golazos, UFC Strike, Disney Pinnacle and Candy MLB. tier_breakdown keys reflect the actual rarity scheme of each collection (Top Shot/All Day/Golazos use common/rare/legendary/ultimate, UFC uses challenger/contender/fandom, Pinnacle uses edition_type variants, Candy MLB uses common/legendary).$nw$;
BEGIN
  IF (SELECT md5(p.prosrc) FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
      WHERE ns.nspname = 'public' AND p.proname = 'analytics_sets_summary')
     IS DISTINCT FROM c_md5 THEN
    RAISE EXCEPTION 'analytics_sets_summary changed since drafting (expected md5 %)', c_md5;
  END IF;

  d := pg_get_functiondef('public.analytics_sets_summary(text[])'::regprocedure);
  n := (length(d) - length(replace(d, old_note, ''))) / length(old_note);
  IF n <> 1 THEN
    RAISE EXCEPTION 'analytics_sets_summary: expected exactly 1 occurrence of the coverage note, found %', n;
  END IF;
  EXECUTE replace(d, old_note, new_note);

  IF (SELECT count(*) FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
      WHERE ns.nspname = 'public' AND p.proname = 'analytics_sets_summary'
        AND p.prosrc LIKE '%Disney Pinnacle and Candy MLB%') <> 1 THEN
    RAISE EXCEPTION 'post-flight: the coverage note should now name Candy MLB';
  END IF;
END
$mig$;