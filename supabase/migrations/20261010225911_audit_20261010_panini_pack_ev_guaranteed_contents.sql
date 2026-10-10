-- audit_20261010_panini_pack_ev_guaranteed_contents
--
-- Pack EV for Panini's SECONDARY-market packs from the contents Panini GUARANTEES on each pack page
-- (Trevor, 2026-10-10: "Do it all"; multi-product doc open item 5: "Many secondary packs publish
-- GUARANTEED contents (raw.pack_label) — deterministic slots, so EV = Σ slots × that family's
-- sale-priced value"). Until now only 4 of 344 packs had EV (WC 1038/1039, WNBA 1055/1056).
--
-- 1. panini_pack_ev_guaranteed_slots — one row per GUARANTEED line of every captured pack, parsed
--    STRICTLY into one of:
--      · count  — "<n> <name> [#/d|#/|limited to|numbered to <print run>]" ("1 Gold Parallel NFTs
--                 #/d 10", "9 Prizm Base NFTs"): editions of the pack's product whose set_name ENDS
--                 with <name> (word-bounded, case-insensitive), at the print run when one is named;
--      · player — "<Player Name> Base" (NFL Instant's one-card packs): that player's Base edition;
--      · unparsed — anything with either / or / other / insert / auto / max / "to 1/1" / non-silver /
--                 a slash between words. A choice, a range or a mixed pool is NOT a deterministic slot.
--    A slot's value is each candidate edition's MEDIAN SALE in the last 90 days (panini_sales — real
--    sales, never FMV or asks), averaged equally over the candidates that sold (mean) and its median
--    across them (typical). (Superseded the same evening by 20261010_..._conservative_imputation.)
-- 2. panini_pack_ev_guaranteed — one row per pack. ev_modeled only when EVERY guaranteed line parsed
--    and every slot passed its gate: candidates share ONE print run; at least half the candidates
--    sold; and >= 10 sales over >= 3 priced editions (a one-edition player slot: >= 5 sales).
--    Otherwise EV is NULL with the reason ("withheld, not zero").
--    ⚠ Caveats the note carries: a secondary pack's remaining pool is unknown, so candidates are
--    weighted equally; editions RPC has not catalogued (listing-gated) cannot be candidates.
-- 3. panini_pack_ev_board — same columns, same WC (2332) and WNBA (2420) arms, now a third arm for
--    every other pack from (2): actual/typical EV, the note, net rip edge, ev_modeled.
--
-- Measured 2026-10-10 PT before the gate change: 34 of 174 count lines and 3 of 139 player lines
-- resolved; 177 lines unparsed. Gate + coverage re-read after apply (see ledger).
--
-- REVERT: restore panini_pack_ev_board from 20261004004005 (its previous definition), then
--   drop view public.panini_pack_ev_guaranteed; drop view public.panini_pack_ev_guaranteed_slots;

create view public.panini_pack_ev_guaranteed_slots with (security_invoker = on) as
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
        ), slot AS (
         SELECT ed_sales.pack_id,
            ed_sales.line_no,
            (count(*))::integer AS candidates,
            (count(*) FILTER (WHERE (ed_sales.n > 0)))::integer AS priced,
            (COALESCE(sum(ed_sales.n), (0)::bigint))::integer AS sales_n,
            (count(DISTINCT ed_sales.mint_cap))::integer AS print_runs,
            avg(ed_sales.med) FILTER (WHERE (ed_sales.n > 0)) AS mean_usd,
            ((percentile_cont((0.5)::double precision) WITHIN GROUP (ORDER BY ((ed_sales.med)::double precision)) FILTER (WHERE (ed_sales.n > 0))))::numeric AS median_usd
           FROM ed_sales
          GROUP BY ed_sales.pack_id, ed_sales.line_no
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

create view public.panini_pack_ev_guaranteed with (security_invoker = on) as
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
            WHEN bool_and(COALESCE(slot_ok, false)) THEN (('modeled from Panini''s guaranteed contents · each slot valued at the 90-day median sale of the editions it can hold (equal weight; a secondary pack''s remaining pool is unknown) · '::text || (sum(sales_n))::text) || ' sales'::text)
            WHEN bool_or((kind = 'unparsed'::text)) THEN 'not modeled · this pack''s guaranteed contents include a choice, a range or a mixed pool, which is not a fixed slot; EV is withheld, not zero'::text
            ELSE 'not modeled · not enough recorded sales (or catalogued editions) for every guaranteed slot of this pack; EV is withheld, not zero'::text
        END AS model_note
   FROM panini_pack_ev_guaranteed_slots
  GROUP BY pack_id, product_set_id;
revoke all on public.panini_pack_ev_guaranteed from public, anon, authenticated;
grant select on public.panini_pack_ev_guaranteed to service_role;
comment on view public.panini_pack_ev_guaranteed is
  'Per-pack EV from Panini''s guaranteed contents (panini_pack_ev_guaranteed_slots): ev_modeled only when every guaranteed line is a priced, deterministic slot. Read by panini_pack_ev_board for packs outside the WC/WNBA models. 2026-10-10.';

create or replace view public.panini_pack_ev_board with (security_invoker = on) as
 SELECT p.id,
    p.collection_id,
    p.pack_type,
    COALESCE(p.floor_usd, p.avg_sale_usd) AS pack_cost_usd,
    p.floor_usd,
    p.avg_sale_usd,
    p.recent_sale_usd,
    p.cards_per_pack,
    p.packs_total,
    p.packs_remaining,
        CASE
            WHEN (COALESCE(p.packs_total, 0) > 0) THEN round(((((p.packs_total - COALESCE(p.packs_remaining, p.packs_total)))::numeric / (p.packs_total)::numeric) * (100)::numeric), 1)
            ELSE NULL::numeric
        END AS packs_ripped_pct,
        CASE
            WHEN (p.model_set_id = 2332) THEN
            CASE
                WHEN (p.pack_type = 'fotl'::text) THEN m.fotl_actual_ev
                ELSE m.hobby_actual_ev
            END
            WHEN ((p.model_set_id = 2420) AND (p.pack_type = 'fotl'::text) AND s.fotl_modeled) THEN s.fotl_actual_ev
            WHEN ((p.model_set_id = 2420) AND (p.pack_type IS DISTINCT FROM 'fotl'::text) AND s.hobby_modeled) THEN s.hobby_actual_ev
            WHEN ((p.model_set_id IS NULL) AND (g.ev_modeled IS TRUE)) THEN g.actual_ev_usd
            ELSE NULL::numeric
        END AS actual_ev_usd,
        CASE
            WHEN (p.model_set_id = 2332) THEN
            CASE
                WHEN (p.pack_type = 'fotl'::text) THEN m.fotl_typical_ev
                ELSE m.hobby_typical_ev
            END
            WHEN ((p.model_set_id = 2420) AND (p.pack_type = 'fotl'::text) AND s.fotl_modeled) THEN (s.fotl_typical_ev)::double precision
            WHEN ((p.model_set_id = 2420) AND (p.pack_type IS DISTINCT FROM 'fotl'::text) AND s.hobby_modeled) THEN (s.hobby_typical_ev)::double precision
            WHEN ((p.model_set_id IS NULL) AND (g.ev_modeled IS TRUE)) THEN (g.typical_ev_usd)::double precision
            ELSE NULL::double precision
        END AS typical_ev_usd,
        CASE
            WHEN (p.model_set_id = 2332) THEN m.silver_ev
            WHEN ((p.model_set_id = 2420) AND
            CASE
                WHEN (p.pack_type = 'fotl'::text) THEN s.fotl_modeled
                ELSE s.hobby_modeled
            END) THEN s.silver_ev
            ELSE NULL::numeric
        END AS silver_ev,
        CASE
            WHEN (p.model_set_id = 2332) THEN m.base_parallel_ev
            WHEN ((p.model_set_id = 2420) AND
            CASE
                WHEN (p.pack_type = 'fotl'::text) THEN s.fotl_modeled
                ELSE s.hobby_modeled
            END) THEN s.base_parallel_ev
            ELSE NULL::numeric
        END AS base_parallel_ev,
        CASE
            WHEN (p.model_set_id = 2332) THEN m.insert_ev
            WHEN ((p.model_set_id = 2420) AND
            CASE
                WHEN (p.pack_type = 'fotl'::text) THEN s.fotl_modeled
                ELSE s.hobby_modeled
            END) THEN s.insert_ev
            ELSE NULL::numeric
        END AS insert_ev,
        CASE
            WHEN (p.model_set_id = 2332) THEN m.fotl_exclusive_ev
            WHEN ((p.model_set_id = 2420) AND (p.pack_type = 'fotl'::text) AND s.fotl_modeled) THEN s.fotl_exclusive_ev
            ELSE NULL::numeric
        END AS fotl_exclusive_ev,
        CASE
            WHEN (p.model_set_id = 2332) THEN m.model_note
            WHEN ((p.model_set_id = 2420) AND
            CASE
                WHEN (p.pack_type = 'fotl'::text) THEN s.fotl_modeled
                ELSE s.hobby_modeled
            END) THEN s.model_note
            WHEN (p.model_set_id = 2420) THEN 'not modeled yet · the sales model for this product needs >=10 sales in every card family of this pack and a fit under 6 hours old; EV is withheld, not zero'::text
            WHEN (g.model_note IS NOT NULL) THEN g.model_note
            WHEN (p.product_set_id = ANY (ARRAY[2332, 2420])) THEN 'not modeled · the EV model covers this product''s standard Hobby and FOTL packs only; this pack''s contents and odds differ; EV is withheld, not zero'::text
            ELSE 'not modeled · no pack-EV model exists for this product yet (card prices for it are not collected); EV is withheld, not zero'::text
        END AS model_note,
        CASE
            WHEN ((p.model_set_id = 2332) AND (COALESCE(p.floor_usd, p.avg_sale_usd) > (0)::numeric)) THEN round((
            CASE
                WHEN (p.pack_type = 'fotl'::text) THEN m.fotl_actual_ev
                ELSE m.hobby_actual_ev
            END - COALESCE(p.floor_usd, p.avg_sale_usd)))
            WHEN ((p.model_set_id = 2420) AND (COALESCE(p.floor_usd, p.avg_sale_usd, p.price_usd) > (0)::numeric) AND
            CASE
                WHEN (p.pack_type = 'fotl'::text) THEN s.fotl_modeled
                ELSE s.hobby_modeled
            END) THEN round((
            CASE
                WHEN (p.pack_type = 'fotl'::text) THEN s.fotl_actual_ev
                ELSE s.hobby_actual_ev
            END - COALESCE(p.floor_usd, p.avg_sale_usd, p.price_usd)))
            WHEN ((p.model_set_id IS NULL) AND (g.ev_modeled IS TRUE) AND (COALESCE(p.floor_usd, p.avg_sale_usd) > (0)::numeric)) THEN round((g.actual_ev_usd - COALESCE(p.floor_usd, p.avg_sale_usd)))
            ELSE NULL::numeric
        END AS net_rip_edge_usd,
    p.updated_at,
    p.product_name,
    p.sport,
    p.product_set_id,
    (((p.model_set_id = 2332) IS TRUE) OR ((p.model_set_id = 2420) AND (
        CASE
            WHEN (p.pack_type = 'fotl'::text) THEN s.fotl_modeled
            ELSE s.hobby_modeled
        END IS TRUE)) OR ((p.model_set_id IS NULL) AND (g.ev_modeled IS TRUE))) AS ev_modeled
   FROM (((( SELECT ps.id,
            ps.collection_id,
            ps.pack_type,
            ps.price_usd,
            ps.cards_per_pack,
            ps.packs_total,
            ps.packs_remaining,
            ps.gross_ev_usd,
            ps.net_ev_usd,
            ps.updated_at,
            ps.floor_usd,
            ps.avg_sale_usd,
            ps.recent_sale_usd,
            ps.top_sale_usd,
            ps.raw,
            ps.product_name,
            ps.sport,
            ps.product_set_id,
            ps.page_url,
                CASE
                    WHEN ((ps.product_set_id = 2332) AND (ps.id = ANY (ARRAY['1038'::text, '1039'::text]))) THEN 2332
                    WHEN ((ps.product_set_id = 2420) AND (ps.id = ANY (ARRAY['1055'::text, '1056'::text]))) THEN 2420
                    ELSE NULL::integer
                END AS model_set_id
           FROM panini_pack_state ps) p
     CROSS JOIN panini_pack_ev_model m)
     LEFT JOIN panini_pack_ev_model_wnba_2026_sales s ON ((s.product_set_id = p.model_set_id)))
     LEFT JOIN panini_pack_ev_guaranteed g ON (((g.pack_id = p.id) AND (p.model_set_id IS NULL))));
