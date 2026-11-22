-- Single-card "Player Base" packs match only the edition minted to the pack's own count (2026-11-22). See repo migration 20261122160000.
create or replace view public.panini_pack_ev_guaranteed_slots with (security_invoker = on) as
 WITH lines AS (
         SELECT s.id AS pack_id,
            s.product_set_id,
            g.ord AS line_no,
            btrim(g.line) AS line,
            (s.raw -> 'pack_config_info' ->> 'unique_cards')::integer AS pack_unique_cards,
            ( SELECT sum((r.value ->> 'total_cards_minted')::integer)
                FROM jsonb_array_elements(
                     CASE WHEN jsonb_typeof(s.raw -> 'pack_config_info' -> 'rarity_distribution') = 'array'
                          THEN s.raw -> 'pack_config_info' -> 'rarity_distribution' ELSE '[]'::jsonb END) r(value)
            )::integer AS pack_minted
           FROM panini_pack_state s
             CROSS JOIN LATERAL ( SELECT c.value AS line,
                    c.ordinality AS ord
                   FROM jsonb_array_elements(
                        CASE
                            WHEN jsonb_typeof((s.raw ->> 'pack_label')::jsonb) = 'array' THEN (s.raw ->> 'pack_label')::jsonb
                            ELSE '[]'::jsonb
                        END) lab(value),
                    LATERAL jsonb_array_elements_text(
                        CASE
                            WHEN jsonb_typeof(lab.value -> 'children') = 'array' THEN lab.value -> 'children'
                            ELSE '[]'::jsonb
                        END) WITH ORDINALITY c(value, ordinality)
                  WHERE (lab.value ->> 'label') = 'GUARANTEED') g
          WHERE s.product_set_id IS NOT NULL AND s.raw ? 'pack_label' AND (s.raw ->> 'pack_label') ~ '^\s*\['
        ), parsed AS (
         SELECT l.pack_id,
            l.product_set_id,
            l.line_no,
            l.line,
            l.pack_unique_cards,
            l.pack_minted,
                CASE
                    WHEN l.line ~* '\m(either|other|or|insert|auto|autograph|max|to 1/1|non[- ]?silver|non[- ]?parallel)\M' OR l.line ~ '/ ' OR l.line ~ '[A-Za-z]/[A-Za-z]' THEN 'unparsed'
                    WHEN l.line ~ '^(?:Guaranteed\s+)?[0-9]+\s' THEN 'count'
                    WHEN l.line ~* '^(?:Guaranteed\s+)?[A-Z].*\sBase$' THEN 'player'
                    ELSE 'unparsed'
                END AS kind,
            substring(l.line FROM '^(?:Guaranteed\s+)?([0-9]+)\s')::integer AS n_cards,
            substring(l.line FROM '(?:#/d|#/|limited to|numbered to)\s*([0-9]+)')::integer AS print_run,
            btrim(regexp_replace(regexp_replace(regexp_replace(regexp_replace(l.line, '^(?:Guaranteed\s+)?[0-9]+\s+', ''), '\(.*\)|(?:#/d|#/|limited to|numbered to)\s*[0-9]+|\meach\M', '', 'gi'), '\m(NFTs?|Cards?|Parallels?)\M', '', 'gi'), '\s+', ' ', 'g')) AS name_part,
            btrim(regexp_replace(regexp_replace(l.line, '^Guaranteed\s+', '', 'i'), '\s+Base\s*$', '')) AS player_part
           FROM lines l
        ), cand AS (
         SELECT p.pack_id,
            p.line_no,
            e.external_id,
            e.mint_cap
           FROM parsed p
             JOIN panini_editions e ON e.product_set_id = p.product_set_id
          WHERE (p.kind = 'count' AND p.name_part <> '' AND lower(e.set_name) ~ (('(^|\s)' || regexp_replace(lower(p.name_part), '([.^$*+?()\[\]{}|\\])', '\\\1', 'g')) || '$') AND (p.print_run IS NULL OR e.mint_cap = p.print_run))
             OR (p.kind = 'player' AND lower(e.player_name) = lower(p.player_part) AND lower(e.set_name) ~ '(^|\s)base$'
                 AND (p.pack_unique_cards IS DISTINCT FROM 1 OR p.pack_minted IS NULL OR e.mint_cap = p.pack_minted))
        ), ed_sales AS (
         SELECT c.pack_id,
            c.line_no,
            c.external_id,
            c.mint_cap,
            x.med,
            x.n
           FROM cand c
             LEFT JOIN LATERAL ( SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY ps.amount_usd::double precision)::numeric AS med,
                    count(*)::integer AS n
                   FROM panini_sales ps
                  WHERE ps.edition_external_id = c.external_id AND ps.sold_at >= (now() - interval '90 days') AND ps.amount_usd > 0) x ON true
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
            count(*)::integer AS candidates,
            count(*) FILTER (WHERE valued.n > 0)::integer AS priced,
            COALESCE(sum(valued.n), 0)::integer AS sales_n,
            count(DISTINCT valued.mint_cap)::integer AS print_runs,
            avg(valued.value_usd) AS mean_usd,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY valued.value_usd::double precision)::numeric AS median_usd
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
    p.kind <> 'unparsed' AND COALESCE(s.candidates, 0) > 0 AND s.print_runs = 1 AND (s.priced * 2) >= s.candidates AND (s.candidates = 1 AND s.sales_n >= 5 OR s.priced >= 3 AND s.sales_n >= 10) AS slot_ok
   FROM parsed p
     LEFT JOIN slot s ON s.pack_id = p.pack_id AND s.line_no = p.line_no;
alter view public.panini_pack_ev_guaranteed_slots set (security_invoker = on);
revoke all on public.panini_pack_ev_guaranteed_slots from public, anon, authenticated;
grant select on public.panini_pack_ev_guaranteed_slots to service_role;