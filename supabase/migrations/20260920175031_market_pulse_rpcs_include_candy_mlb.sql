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