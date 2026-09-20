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