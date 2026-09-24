-- audit_20260924_pack_dist_relabel_from_the_studio_index
--
-- FOLLOWS 20260924123824 (vote fills, never overwrites + identity relabel) and the three
-- 2026-09-24 migrations that moved per-dist pack market stats onto pack_purchases.
--
-- WHAT WAS WRONG (found 2026-09-24 ~7:10 AM PT by a read-only review of those commits):
-- pack_market_sales_stats() now groups Top Shot pack sales by pack_purchases.pack_dist_id.
-- That label came from pack_rips via the propagate trigger, and the old pool vote had
-- OVERWRITTEN it. 20260924123824 repaired only packs that have a pack_nft_identity row
-- (~150k of ~554k sold packs). Packs WITHOUT one kept the wrong dist, so the pack page and the
-- public pack-market board published one pack's price and volume under another pack's name
-- (SUBSTITUTION: every helper reports success). Worked example, measured before this fix: of
-- the sales Dapper's own index labels dist 7726 (Rookie Revelation Standard), 3,495 carried
-- pack_dist_id 7800 (Fast Break Classic Run 12 – 4 Wins) and 0 of those had an identity row.
--
-- THE SOURCE IS PROVEN BEFORE IT IS USED: topshot_pack_sales_history (Dapper's studio listing
-- index) gives exactly ONE dist per pack NFT on all 553,615 packs it names, and agrees with
-- pack_nft_identity on 50,165 of 50,165 packs where both exist (0 disagreements).
--
-- FIX (one-off, Top Shot only; All Day measured clean): for every pack NFT with NO usable
-- identity row whose studio dist differs from the stored one, relabel pack_purchases.pack_dist_id
-- (34,540 rows at sizing) and pack_rips.dist_id (28,940 rows) to the studio dist. Every change is
-- recorded in audit_20260924_pack_dist_relabel_studio for revert, and the market cache is
-- re-queued for every dist on either side. Identity-covered packs are untouched (identity wins).
-- The propagate trigger only fills NULL pack_dist_id, so it neither fights nor duplicates this.
--
-- NOT DONE HERE (filed): a recurring correction. With the vote fill-only since 20260924123824,
-- a wrong label can now only enter when the vote fills a NULL before either index answers.
-- WATCH: new pack_purchases rows whose pack_dist_id disagrees with the studio dist.
-- Falsifier: > 0.5 % of studio-matched Top Shot purchases sealed after this migration.
--
-- REVERT:
--   UPDATE public.pack_rips r SET dist_id = a.old_dist FROM public.audit_20260924_pack_dist_relabel_studio a
--    WHERE a.tbl = 'pack_rips' AND r.id = a.row_id;
--   UPDATE public.pack_purchases p SET pack_dist_id = a.old_dist FROM public.audit_20260924_pack_dist_relabel_studio a
--    WHERE a.tbl = 'pack_purchases' AND p.id = a.row_id;
--   then re-queue pack_market_sales_cache as below.

CREATE TABLE IF NOT EXISTS public.audit_20260924_pack_dist_relabel_studio (
  tbl text NOT NULL, row_id uuid NOT NULL, collection_id uuid, pack_nft_id text,
  old_dist text, new_dist text, relabelled_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tbl, row_id)
);
REVOKE ALL ON public.audit_20260924_pack_dist_relabel_studio FROM PUBLIC, anon, authenticated;
ALTER TABLE public.audit_20260924_pack_dist_relabel_studio ENABLE ROW LEVEL SECURITY;

CREATE TEMP TABLE _studio_dist ON COMMIT DROP AS
SELECT h.pack_nft_id, min(h.dist_id) AS dist_id
  FROM public.topshot_pack_sales_history h
 WHERE h.dist_id IS NOT NULL AND h.dist_id <> '0'
 GROUP BY h.pack_nft_id
HAVING count(DISTINCT h.dist_id) = 1;
CREATE INDEX ON _studio_dist (pack_nft_id);

INSERT INTO public.audit_20260924_pack_dist_relabel_studio (tbl, row_id, collection_id, pack_nft_id, old_dist, new_dist)
SELECT 'pack_purchases', p.id, p.collection_id, p.pack_nft_id, p.pack_dist_id, s.dist_id
  FROM public.pack_purchases p
  JOIN _studio_dist s ON s.pack_nft_id = p.pack_nft_id
 WHERE p.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
   AND p.pack_dist_id IS DISTINCT FROM s.dist_id
   AND NOT EXISTS (SELECT 1 FROM public.pack_nft_identity i
                    WHERE i.collection_id = p.collection_id AND i.pack_nft_id = p.pack_nft_id
                      AND i.dist_id IS NOT NULL AND i.dist_id <> '0')
ON CONFLICT DO NOTHING;

INSERT INTO public.audit_20260924_pack_dist_relabel_studio (tbl, row_id, collection_id, pack_nft_id, old_dist, new_dist)
SELECT 'pack_rips', r.id, r.collection_id, r.pack_nft_id, r.dist_id, s.dist_id
  FROM public.pack_rips r
  JOIN _studio_dist s ON s.pack_nft_id = r.pack_nft_id
 WHERE r.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
   AND r.dist_id IS DISTINCT FROM s.dist_id
   AND NOT EXISTS (SELECT 1 FROM public.pack_nft_identity i
                    WHERE i.collection_id = r.collection_id AND i.pack_nft_id = r.pack_nft_id
                      AND i.dist_id IS NOT NULL AND i.dist_id <> '0')
ON CONFLICT DO NOTHING;

UPDATE public.pack_purchases p SET pack_dist_id = a.new_dist
  FROM public.audit_20260924_pack_dist_relabel_studio a
 WHERE a.tbl = 'pack_purchases' AND p.id = a.row_id;

UPDATE public.pack_rips r SET dist_id = a.new_dist
  FROM public.audit_20260924_pack_dist_relabel_studio a
 WHERE a.tbl = 'pack_rips' AND r.id = a.row_id;

-- Re-queue the pack market cache for every dist either side of a relabel.
UPDATE public.pack_market_sales_cache c SET computed_at = '1970-01-01'::timestamptz
 WHERE c.computed_at > '-infinity'::timestamptz
   AND c.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
   AND EXISTS (SELECT 1 FROM public.audit_20260924_pack_dist_relabel_studio a
                WHERE a.tbl = 'pack_purchases' AND c.dist_id IN (a.old_dist, a.new_dist));
