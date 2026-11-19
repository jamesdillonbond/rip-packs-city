-- audit_20261119_candy_revival_arm_counts_dollars_not_sales
--
-- 2026-11-19 (PT, morning by DB clock; Claude Code cloud; Trevor: "Keep going and make your own decisions"
-- -- the arm's definition had been "Trevor's call" (ledger 11-11); he delegated it this session).
-- v_rpc_trust_health.candy_revival_sales_since_recorded_silence breached on 10 Candy SALES after the recorded
-- silence date. A wind-down dust trickle crosses that every ~4 days (re-dated 11-10, 11-11, 11-14, 11-18), and
-- at 8:40 AM PT 11-19 it read 14 sales = $21.72 -- a breach again, one day after the last re-date. Each re-date
-- is a monitor filing + a migration, and the board sits red in between (the "permanently red arm teaches the
-- operator to skim" shape the arm's own text warns about).
--
-- DECISION (option (a) of inbox 11-19T0200Z): count DOLLARS, breach at $250 since the recorded date. Measured
-- there: (a) stays green through all four trickles and WOULD have fired on the one real batch (11-14, $637.62 of
-- legacy DC comics); option (b), current-set sales only, would have missed it.
--
-- WHAT. A splice of THIS ARM ONLY (its segment, from its name to the next UNION ALL; every replacement must
-- match exactly once), md5-guarded on the whole live view; the arm keeps its NAME (consumers key on it).
-- CREATE OR REPLACE VIEW resets reloptions, so security_invoker is re-set.
--
-- REVERT: the same splice reversed (count(*) and floor 10, old text), or restore from the live definition
-- captured by md5 48b93f5db9440cca3fe328b9b9eaafdd.

DO $do$
DECLARE
  v_def text := pg_get_viewdef('public.v_rpc_trust_health'::regclass);
  v_p1 int;
  v_len int;
  v_seg text;
  v_new text;
  r record;
BEGIN
  IF md5(v_def) <> '48b93f5db9440cca3fe328b9b9eaafdd' THEN
    RAISE EXCEPTION 'v_rpc_trust_health changed since this splice was written';
  END IF;
  v_p1 := position('''candy_revival_sales_since_recorded_silence''::text AS text' IN v_def);
  IF v_p1 = 0 THEN RAISE EXCEPTION 'arm not found'; END IF;
  v_len := position('UNION ALL' IN substr(v_def, v_p1)) - 1;
  IF v_len <= 0 THEN RAISE EXCEPTION 'arm end not found'; END IF;
  v_seg := substr(v_def, v_p1, v_len);
  v_new := v_seg;
  FOR r IN SELECT * FROM (VALUES
    ('(count(*))::numeric AS count', 'COALESCE(sum(s.price_usd), (0)::numeric) AS usd'),
    ('(10)::numeric AS "numeric"', '(250)::numeric AS "numeric"'),
    ('REVIVAL DETECTOR (FLOOR 10 since 2026-11-11: one stray sale no longer breaches; six trickle sales in four weeks forced two re-dates)',
     'REVIVAL DETECTOR (since 2026-11-19: USD of Candy sales, floor $250. The old 10-SALE floor was crossed by a wind-down dust trickle every ~4 days: re-dated 11-10/11/14/18, and 14 sales = $21.72 on 11-19; the one real batch, 11-14, was $637.62)'),
    ('Counts Candy sales on or after', 'Sums the USD of Candy sales on or after'),
    ('BREACHES on the first sale', 'BREACHES once that passes $250')
  ) AS t(old, new) LOOP
    IF (length(v_new) - length(replace(v_new, r.old, ''))) / length(r.old) <> 1 THEN
      RAISE EXCEPTION 'anchor not exactly once in the arm: %', r.old;
    END IF;
    v_new := replace(v_new, r.old, r.new);
  END LOOP;
  EXECUTE 'CREATE OR REPLACE VIEW public.v_rpc_trust_health AS ' || overlay(v_def PLACING v_new FROM v_p1 FOR v_len);
  ALTER VIEW public.v_rpc_trust_health SET (security_invoker = on);
END
$do$;
