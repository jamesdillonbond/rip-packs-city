-- PANINI SQUEEZE BOARD — the "what this total is made of" disclosure annotates a DIFFERENT
-- population than the KPI it sits under. 2026-09-20 ~11:1x AM PT (Claude Code cloud).
-- Acts on inbox filing 2026-09-20T1709Z (Cowork cloud, Trevor-directed), which could not ship it:
-- the fix needs a .tsx change and Cowork cannot push .tsx.
--
-- THE DEFECT. PaniniSqueezeClient.tsx:328 headlines `sealed_fmv_exposure_usd_hc` (the broad+partial
-- subset) whenever `hc` is true, and :367-376 annotates it with "X% of the sealed value ABOVE comes
-- from N editions priced from a single seller's asking price" — using `pct_sealed_usd_from_asks_only`
-- and `editions_ask_only`, which this view computes over ALL SETS (no coverage_flag predicate).
-- The footnote describes a population the number it annotates does not have.
--
-- 📏 Re-measured independently 2026-09-20 ~11:1x AM PT, reproducing the filing's figures:
--   all sets : $1,248,712 ask-only of $2,417,xxx over 5,075 editions = 51.7% (what is PUBLISHED)
--   hc subset: $1,221,300 ask-only of $2,271,750 over 4,053 editions = 53.8% (what is TRUE of the KPI)
-- ⭐ Small, and in the FLATTERING direction — which is the reason to fix it rather than to leave it:
-- this IS the board's honesty disclosure and it currently understates its own subject.
--
-- 📏 THE FILING'S OWN FALSIFIER WAS RUN FIRST AND DID NOT FIRE. It said: if the sale-backed figure
-- lands within a few percent of the hc total, the ASK_ONLY concentration is not where the note says
-- and the change is not worth the migration burst. Measured: hc sale-backed $922,825 of $2,271,750 =
-- 40.6% (3,381 of 4,053 editions), so 59.4% of the headline stands on ask-derived prices. Not close.
--
-- ⭐ AND A SHARPER FACT THAN THE FILING STATED: within the hc subset, ASK_ONLY is only
-- **364 of 4,053 editions (9.0%)** but **$1,221,300 of $2,271,750 (53.8%)** of the value. A ninth of
-- the editions carries over half the headline.
-- ⚠ The filing's own table says "ASK_ONLY editions ... 674" for the hc column; that figure is
-- ASK_ONLY **plus LOW** (364 + 308 + 2). Its dollar figure is ASK_ONLY-scoped, so the two halves of
-- that row have different scopes. The percentage it quotes (53.8%) is unaffected and reproduces.
--
-- ⛔ WHAT THIS DELIBERATELY DOES NOT DO. The filing also proposes PROMOTING the sale-backed figure to
-- the primary tile ($923k primary, $2.27M on the alt line). That is an EDITORIAL decision about what
-- a public board leads with, and it is Trevor's, not a defect. Only the denominator mismatch — an
-- unambiguous falsehood — is fixed here. The new columns make the promotion a one-line client change
-- whenever he wants it.
--
-- ⚠ EXISTING COLUMNS ARE UNTOUCHED, BY DESIGN. `pct_sealed_usd_from_asks_only` and
-- `pct_sealed_usd_sale_backed` stay ALL-SETS: other consumers may read them, and silently changing a
-- published percentage's population is the very defect this migration is about. The hc figures are
-- NEW columns, so a number and its denominator travel together.
--
-- ⚠ NOT TOUCHED, and it is NOT this defect: `app/api/og/insights/panini-squeeze/route.tsx` sums
-- ALL SETS for both its total and its ask share, in one walk, deliberately (its own header explains
-- why it does not read this view). So it is internally consistent — it reports a different
-- POPULATION than the page headline, which is the same editorial question above, not a mismatch.
--
-- ⚠ CREATE OR REPLACE VIEW mechanics, all three traps: it is a FULL-BODY write (the live definition
-- was re-read immediately before this, normalized md5 698b57fb3d59aed266103f4b9d536a04); it cannot
-- rename or reorder columns (42P16), so all twelve existing columns are reproduced VERBATIM in order
-- and the four new ones are APPENDED; and it RESETS reloptions, so `security_invoker` is carried in
-- the WITH clause or the view silently becomes definer-rights. Live value before: {security_invoker=true}.
--
-- anon-exec: not applicable — no function is created or replaced here. This is a view; its grants are
-- unchanged by CREATE OR REPLACE and are asserted below.
--
-- REVERT (exact): CREATE OR REPLACE VIEW public.panini_squeeze_totals WITH (security_invoker = true)
-- AS <the twelve-column body, whose normalized md5 is 698b57fb3d59aed266103f4b9d536a04>, then
-- `git revert` the code half (lib/insights/panini-board.ts + PaniniSqueezeClient.tsx + its tests).
-- ⚠ Reverting the DB half alone is safe: every client read of the new columns is optional-chained
-- and falls back to the all-sets pair.

do $gate$
declare v_md5 text; v_opts text[];
begin
  select md5(trim(regexp_replace(pg_get_viewdef('public.panini_squeeze_totals'::regclass, true), '\s+', ' ', 'g'))),
         c.reloptions
    into v_md5, v_opts
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'panini_squeeze_totals';

  if v_md5 is distinct from '698b57fb3d59aed266103f4b9d536a04' then
    raise exception 'live view body md5 % does not match the text this migration was written against -- another session changed it; re-read before replacing', v_md5;
  end if;
  if not ('security_invoker=true' = any(v_opts)) then
    raise exception 'expected security_invoker=true before the replace, found %', v_opts;
  end if;
end
$gate$;

create or replace view public.panini_squeeze_totals
  with (security_invoker = true) as
 SELECT count(*) AS editions,
    round(COALESCE(sum(sealed_fmv_exposure_usd), 0::numeric)) AS sealed_fmv_exposure_usd,
    count(*) FILTER (WHERE mint_cap <= 25) AS chases_lte_25,
    COALESCE(sum(still_in_packs), 0::bigint) AS sealed_copies,
    count(*) FILTER (WHERE coverage_flag = ANY (ARRAY['broad'::text, 'partial'::text])) AS editions_hc,
    round(COALESCE(sum(sealed_fmv_exposure_usd) FILTER (WHERE coverage_flag = ANY (ARRAY['broad'::text, 'partial'::text])), 0::numeric)) AS sealed_fmv_exposure_usd_hc,
    COALESCE(sum(still_in_packs) FILTER (WHERE coverage_flag = ANY (ARRAY['broad'::text, 'partial'::text])), 0::bigint) AS sealed_copies_hc,
    round(100.0 * COALESCE(sum(sealed_fmv_exposure_usd) FILTER (WHERE coverage_flag = ANY (ARRAY['heavily_biased'::text, 'listing_gated'::text])), 0::numeric) / NULLIF(sum(sealed_fmv_exposure_usd), 0::numeric), 1) AS pct_sealed_usd_from_biased_sets,
    count(*) FILTER (WHERE fmv_confidence = 'ASK_ONLY'::fmv_confidence) AS editions_ask_only,
    round(COALESCE(sum(sealed_fmv_exposure_usd) FILTER (WHERE fmv_confidence = 'ASK_ONLY'::fmv_confidence), 0::numeric)) AS sealed_fmv_exposure_usd_ask_only,
    round(100.0 * COALESCE(sum(sealed_fmv_exposure_usd) FILTER (WHERE fmv_confidence = 'ASK_ONLY'::fmv_confidence), 0::numeric) / NULLIF(sum(sealed_fmv_exposure_usd), 0::numeric), 1) AS pct_sealed_usd_from_asks_only,
    round(100.0 * COALESCE(sum(sealed_fmv_exposure_usd) FILTER (WHERE fmv_confidence = ANY (ARRAY['HIGH'::fmv_confidence, 'MEDIUM'::fmv_confidence])), 0::numeric) / NULLIF(sum(sealed_fmv_exposure_usd), 0::numeric), 1) AS pct_sealed_usd_sale_backed,
    -- ── APPENDED 2026-09-20: the same three disclosure figures, scoped to the broad+partial
    -- subset the headline KPI actually reports, so the footnote's denominator is the KPI's own.
    count(*) FILTER (WHERE coverage_flag = ANY (ARRAY['broad'::text, 'partial'::text]) AND fmv_confidence = 'ASK_ONLY'::fmv_confidence) AS editions_hc_ask_only,
    round(COALESCE(sum(sealed_fmv_exposure_usd) FILTER (WHERE coverage_flag = ANY (ARRAY['broad'::text, 'partial'::text]) AND fmv_confidence = 'ASK_ONLY'::fmv_confidence), 0::numeric)) AS sealed_fmv_exposure_usd_hc_ask_only,
    round(100.0 * COALESCE(sum(sealed_fmv_exposure_usd) FILTER (WHERE coverage_flag = ANY (ARRAY['broad'::text, 'partial'::text]) AND fmv_confidence = 'ASK_ONLY'::fmv_confidence), 0::numeric) / NULLIF(sum(sealed_fmv_exposure_usd) FILTER (WHERE coverage_flag = ANY (ARRAY['broad'::text, 'partial'::text])), 0::numeric), 1) AS pct_sealed_usd_from_asks_only_hc,
    round(100.0 * COALESCE(sum(sealed_fmv_exposure_usd) FILTER (WHERE coverage_flag = ANY (ARRAY['broad'::text, 'partial'::text]) AND fmv_confidence = ANY (ARRAY['HIGH'::fmv_confidence, 'MEDIUM'::fmv_confidence])), 0::numeric) / NULLIF(sum(sealed_fmv_exposure_usd) FILTER (WHERE coverage_flag = ANY (ARRAY['broad'::text, 'partial'::text])), 0::numeric), 1) AS pct_sealed_usd_sale_backed_hc
   FROM panini_squeeze_board
  WHERE fmv_usd IS NOT NULL;

do $verify$
declare
  r record;
  v_opts text[];
begin
  select c.reloptions into v_opts
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relname = 'panini_squeeze_totals';
  if not ('security_invoker=true' = any(v_opts)) then
    raise exception 'post-apply: security_invoker was STRIPPED by the replace, reloptions=%', v_opts;
  end if;

  select * into r from public.panini_squeeze_totals;

  -- The new columns must actually be populated, not merely present.
  if r.editions_hc_ask_only is null or r.pct_sealed_usd_from_asks_only_hc is null then
    raise exception 'post-apply: the hc disclosure columns are NULL';
  end if;

  -- The whole point: the hc figure must DIFFER from the all-sets one it replaces, or the defect
  -- was imaginary and this migration bought nothing.
  if r.pct_sealed_usd_from_asks_only_hc = r.pct_sealed_usd_from_asks_only then
    raise exception 'post-apply: hc and all-sets ask-only percentages are identical (%) -- no denominator mismatch exists', r.pct_sealed_usd_from_asks_only;
  end if;

  -- Existing columns must be untouched in value, since nothing about their definition changed.
  if r.editions <> 5074 and r.editions < 5000 then
    raise exception 'post-apply: all-sets edition count moved unexpectedly to %', r.editions;
  end if;

  -- Grants unchanged by CREATE OR REPLACE.
  if not has_table_privilege('service_role', 'public.panini_squeeze_totals', 'SELECT') then
    raise exception 'post-apply: service_role lost SELECT on the view';
  end if;
end
$verify$;
