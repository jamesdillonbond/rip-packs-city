-- audit_20261010_panini_pack_ev_guaranteed_conservative_imputation
--
-- Follow-up to 20261010225911 (panini_pack_ev_guaranteed_contents), same evening. That version
-- averaged a slot over only the candidate editions that SOLD in 90 days. The editions that sell skew
-- to stars, so the slot was inflated by survivorship — measured: the WC White Sparkle /8 pack (1043)
-- read $366 mean vs a $250 floor on 113 of 186 sold editions, a +$116 rip "edge" the board would
-- have published. Now every candidate counts (equal weight) and a candidate with no sale in the
-- window is valued at the slot's LOWEST sold median, so EV is a conservative estimate, never an
-- inflated one. Same columns; the gate is unchanged; the note says so.
--
-- REVERT: re-apply the two view bodies in 20261010225911.

create or replace view public.panini_pack_ev_guaranteed_slots with (security_invoker = on) as
 WITH lines AS (
         SELECT s.id AS pack_id,
            s.product_set_id,
            g.ord AS line_no,
            btrim(g.line) AS line
           FROM panini_pack_state s
             CROSS JOIN LATERAL ( SELECT c.value AS line,
                    c.ordinality AS ord
                   FROM jsonb_array_elements(
                        CASE
                            WHEN (jsonb_typeof(((s.raw ->> 'pack_label'::text))::jsonb) = 'array'::text) THEN ((s.raw ->> 'pack_label'::text))::jsonb
                            ELSE '[]'::jsonb
                        END) lab(value),
                    LATERAL jsonb_array_elements_text(
                        CASE
                            WHEN (jsonb_typeof((lab.value -> 'children'::text)) = 'array'::text) THEN (lab.value -> 'children'::text)
                            ELSE '[]'::jsonb
                        END) WITH ORDINALITY c(value, ordinality)
                  WHERE ((lab.value ->> 'label'::text) = 'GUARANTEED'::text)) g
          WHERE ((s.product_set_id IS NOT NULL) AND (s.raw ? 'pack_label'::text) AND ((s.raw ->> 'pack_label'::text) ~ '^\s*\['::text))
        ), parsed AS (
         SELECT l.pack_id,
            l.product_set_id,
            l.line_no,
            l.line,
                CASE
                    WHEN ((l.line ~* '\m(either|other|or|insert|auto|autograph|max|to 1/1|non[- ]?silver|non[- ]?parallel)\M'::text) OR (l.line ~ '/ '::text) OR (l.line ~ '[A-Za-z]/[A-Za-z]'::text)) THEN 'unparsed'::text
                    WHEN (l.line ~ '^(?:Guaranteed\s+)?[0-9]+\s'::text) THEN 'count'::text
                    WHEN (l.line ~* '^(?:Guaranteed\s+)?[A-Z].*\sBase$'::text) THEN 'player'::text
                    ELSE 'unparsed'::text
                END AS kind,
            (substring(l.line FROM '^(?:Guaranteed\s+)?([0-9]+)\s'::text))::integer AS n_cards,
            (substring(l.line FROM '(?:#/d|#/|limited to|numbered to)\s*([0-9]+)'::text))::integer AS print_run,
            btrim(regexp_replace(regexp_replace(regexp_replace(regexp_replace(l.line, '^(?:Guaranteed\s+)?[0-9]+\s+'::text, ''::text), '\(.*\)|(?:#/d|#/|limited to|numbered to)\s*[0-9]+|\meach\M'::text, ''::text, 'gi'::text), '\m(NFTs?|Cards?|Parallels?)\M'::text, ''::text, 'gi'::text), '\s+'::text, ' '::text, 'g'::text)) AS name_part,
            btrim(regexp_replace(regexp_replace(l.line, '^Guaranteed\s+'::text, ''::text, 'i'::text), '\s+Base\s*$'::text, ''::text)) AS player_part
           FROM lines l
        ), cand AS (
         SELECT p.pack_id,
            p.line_no,
            e.external_id,
            e.mint_cap
           FROM (parsed p
             JOIN panini_editions e ON ((e.product_set_id = p.product_set_id)))
          WHERE (((p.kind = 'count'::text) AND (p.name_part <> ''::text) AND (lower(e.set_name) ~ (('(^|\s)'::text || regexp_replace(lower(p.name_part), '([.^$*+?()\[\]{}|\\])'::text, '\\\1'::text, 'g'::text)) || '$'::text)) AND ((p.print_run IS NULL) OR (e.mint_cap = p.print_run))) OR ((p.kind = 'player'::text) AND (lower(e.player_name) = lower(p.player_part)) AND (lower(e.set_name) ~ '(^|\s)base$'::text)))
        ), ed_sales AS (
         SELECT c.pack_id,
            c.line_no,
            c.external_id,
            c.mint_cap,
            x.med,
            x.n
           FROM (cand c
             LEFT JOIN LATERAL ( SELECT (percentile_cont((0.5)::double precision) WITHIN GROUP (ORDER BY ((ps.amount_usd)::double precision)))::numeric AS med,
                    (count(*))::integer AS n
                   FROM panini_sales ps
                  WHERE ((ps.edition_external_id = c.external_id) AND (ps.sold_at >= (now() - '90 days'::interval)) AND (ps.amount_usd > (0)::numeric))) x ON (true))
        ), valued AS (
         SELECT ed_sales.pack_id,
            ed_sales.line_no,
            ed_sales.mint_cap,
            ed_sales.n,
            COALESCE(ed_sales.med, min(ed_sales.med) OVER (PARTITION BY ed_sales.pack_id, ed_sales.line_no)) AS value_usd
           FROM ed_sales
        ), slot AS (
         SELECT valued.pack_id,
            valued.line_no,
            (count(*))::integer AS candidates,
            (count(*) FILTER (WHERE (valued.n > 0)))::integer AS priced,
            (COALESCE(sum(valued.n), (0)::bigint))::integer AS sales_n,
            (count(DISTINCT valued.mint_cap))::integer AS print_runs,
            avg(valued.value_usd) AS mean_usd,
            ((percentile_cont((0.5)::double precision) WITHIN GROUP (ORDER BY ((valued.value_usd)::double precision))))::numeric AS median_usd
           FROM valued
          GROUP BY valued.pack_id, valued.line_no
        )
 SELECT p.pack_id,
    p.product_set_id,
    p.line_no,
    p.line,
    p.kind,
    COALESCE(p.n_cards, 1) AS n_cards,
    p.print_run,
    COALESCE(s.candidates, 0) AS candidates,
    COALESCE(s.priced, 0) AS priced,
    COALESCE(s.sales_n, 0) AS sales_n,
    COALESCE(s.print_runs, 0) AS print_runs,
    round(s.mean_usd, 2) AS mean_usd,
    round(s.median_usd, 2) AS median_usd,
    ((p.kind <> 'unparsed'::text) AND (COALESCE(s.candidates, 0) > 0) AND (s.print_runs = 1) AND ((s.priced * 2) >= s.candidates) AND (((s.candidates = 1) AND (s.sales_n >= 5)) OR ((s.priced >= 3) AND (s.sales_n >= 10)))) AS slot_ok
   FROM (parsed p
     LEFT JOIN slot s ON (((s.pack_id = p.pack_id) AND (s.line_no = p.line_no))));
revoke all on public.panini_pack_ev_guaranteed_slots from public, anon, authenticated;
grant select on public.panini_pack_ev_guaranteed_slots to service_role;
comment on view public.panini_pack_ev_guaranteed_slots is
  'Each GUARANTEED line of every captured Panini pack, parsed strictly (count / player / unparsed) and valued from candidate editions'' 90-day median SALES. slot_ok = the line is deterministic and sale-backed enough to price. Feeds panini_pack_ev_guaranteed. 2026-10-10.';

create or replace view public.panini_pack_ev_guaranteed with (security_invoker = on) as
 SELECT pack_id,
    product_set_id,
    (count(*))::integer AS guaranteed_lines,
    (count(*) FILTER (WHERE slot_ok))::integer AS lines_priced,
    bool_and(COALESCE(slot_ok, false)) AS ev_modeled,
        CASE
            WHEN bool_and(COALESCE(slot_ok, false)) THEN round(sum(((n_cards)::numeric * mean_usd)), 2)
            ELSE NULL::numeric
        END AS actual_ev_usd,
        CASE
            WHEN bool_and(COALESCE(slot_ok, false)) THEN round(sum(((n_cards)::numeric * median_usd)), 2)
            ELSE NULL::numeric
        END AS typical_ev_usd,
    (sum(sales_n))::integer AS sales_n,
        CASE
            WHEN bool_and(COALESCE(slot_ok, false)) THEN (('modeled from Panini''s guaranteed contents · each slot valued at the 90-day median sale of the editions it can hold (equal weight, unsold editions at the slot''s lowest sale — conservative; a secondary pack''s remaining pool is unknown) · '::text || (sum(sales_n))::text) || ' sales'::text)
            WHEN bool_or((kind = 'unparsed'::text)) THEN 'not modeled · this pack''s guaranteed contents include a choice, a range or a mixed pool, which is not a fixed slot; EV is withheld, not zero'::text
            ELSE 'not modeled · not enough recorded sales (or catalogued editions) for every guaranteed slot of this pack; EV is withheld, not zero'::text
        END AS model_note
   FROM panini_pack_ev_guaranteed_slots
  GROUP BY pack_id, product_set_id;
revoke all on public.panini_pack_ev_guaranteed from public, anon, authenticated;
grant select on public.panini_pack_ev_guaranteed to service_role;
comment on view public.panini_pack_ev_guaranteed is
  'Per-pack EV from Panini''s guaranteed contents (panini_pack_ev_guaranteed_slots): ev_modeled only when every guaranteed line is a priced, deterministic slot. Read by panini_pack_ev_board for packs outside the WC/WNBA models. 2026-10-10.';

