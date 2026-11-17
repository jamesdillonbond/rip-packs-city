-- audit_20261108_panini_pack_drops — 2026-11-08 (Cowork cloud, ~2:15 PM PT; Trevor 1:49 PM PT:
-- "Yes do it all, cover all collections and figure it out fully").
--
-- WHY. The @RipPacksCity drops calendar (docs/social/x-calendar.md) had no Panini source:
-- panini_products.first_seen_at is when OUR runner discovered a product (six Entertainment products
-- all "first seen" 11-08 11:04 AM PT when the runner learned that filter), not a release date.
--
-- FOUND (read in Trevor's Chrome, 11-08 ~2 PM PT). Panini's own NFT store answers two signed
-- /onepanini queries that carry real release dates:
--   · `packs`          — the NFT STORE list (nft-store/nft-pack.html): every pack on sale now,
--                        with start_date, price, cards per pack, in_stock, remaining qty.
--   · `packsTimeline`  — the PACK TIMELINE (nft-store/pack-timeline.html): every pack Panini has
--                        released, by year (340 rows), with start_date and total qty.
-- start_date is UTC: every 2026 pack starts at 15:00 (PDT) or 16:00 (PST) — Panini's 8 AM PT drop,
-- e.g. 1060 "2026 Panini NFT Prizm The Rolling Stones Packs" 2026-11-06 16:00 = the store's "NOV 6".
-- Both are signed per request (authorization + signature headers), so they are read the way
-- every other Panini field is: by the residential runner, which loads those two store pages in the
-- real browser and posts what the SPA fetched (`pack_drops`, app/api/cron/panini-ingest).
--
-- WHAT. panini_pack_drops — one row per Panini pack id, upserted by the ingest route; service-role
-- only (read by /api/public/insights/pack-calendar). Seeded with the nine 2026 packs read at
-- ~2:05 PM PT so the calendar is right before the runner's next pass (6 AM PT + every 2 h).
--
-- REVERT: DROP TABLE public.panini_pack_drops;

CREATE TABLE IF NOT EXISTS public.panini_pack_drops (
  pack_id         text        PRIMARY KEY CHECK (pack_id ~ '^[0-9]+$'),
  name            text        NOT NULL,
  sport           text,
  price_usd       numeric,
  cards_per_pack  integer,
  start_at        timestamptz,
  end_at          timestamptz,
  in_stock        boolean,
  is_available    boolean,
  status          integer,
  url_key         text,
  total_qty       integer,
  remaining_qty   integer,
  -- which Panini list(s) the row was last read from: 'store', 'timeline'
  seen_in         text[]      NOT NULL DEFAULT '{}',
  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.panini_pack_drops IS
  'Panini NFT store packs with Panini''s own release date (start_at, UTC) — from the store `packs` and `packsTimeline` queries the residential runner captures (app/api/cron/panini-ingest, body.pack_drops). Feeds the pack calendar. 2026-11-08.';

ALTER TABLE public.panini_pack_drops ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.panini_pack_drops FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.panini_pack_drops TO service_role;

CREATE INDEX IF NOT EXISTS idx_panini_pack_drops_start_at ON public.panini_pack_drops (start_at);

INSERT INTO public.panini_pack_drops
  (pack_id, name, sport, price_usd, cards_per_pack, start_at, in_stock, is_available, status, url_key, total_qty, remaining_qty, seen_in, first_seen_at, last_seen_at)
VALUES
  ('1060', '2026 Panini NFT Prizm The Rolling Stones Packs', 'ENTERTAINMENT', 25, 5, '2026-11-06 16:00:00+00', true, true, 1, 'pack-2026_Panini_NFT_Prizm_The_Rolling_Stones_Packs', NULL, 18586, '{store}', '2026-11-08 22:05:00+00', '2026-11-08 22:05:00+00'),
  ('1058', '2026 Panini NFT Prizm FIFA World Cup Sticker Packs', 'SOCCER', 8, 5, '2026-10-26 15:00:00+00', false, true, 2, 'pack-2026_Panini_NFT_Prizm_FIFA_World_Cup_Sticker_Packs', 160320, 0, '{timeline}', '2026-11-08 22:05:00+00', '2026-11-08 22:05:00+00'),
  ('1056', '2026 Panini NFT Prizm WNBA Packs', 'WOMENS BASKETBALL', 30, 4, '2026-09-30 15:00:00+00', true, true, 1, 'pack-2026_Panini_NFT_Prizm_WNBA_Packs', 23512, 228, '{store,timeline}', '2026-11-08 22:05:00+00', '2026-11-08 22:05:00+00'),
  ('1055', '2026 Panini NFT Prizm WNBA FOTL Packs', 'WOMENS BASKETBALL', 150, 5, '2026-09-28 15:00:00+00', true, true, 1, 'pack-2026_Panini_NFT_Prizm_WNBA_FOTL_Packs', 5488, 54, '{store,timeline}', '2026-11-08 22:05:00+00', '2026-11-08 22:05:00+00'),
  ('1057', '2026 Panini NFT Bad Eggs -The Teams of New Yolk City Bronze Packs', 'ENTERTAINMENT', 0, 1, '2026-09-25 15:00:00+00', false, false, 2, 'pack-2026_Panini_NFT_Bad_Eggs__The_Teams_of_New_Yolk_City_Bronze_Packs', 1620, 0, '{timeline}', '2026-11-08 22:05:00+00', '2026-11-08 22:05:00+00'),
  ('1053', '2026 Panini NFT Bad Eggs -The Teams of New Yolk City Packs', 'ENTERTAINMENT', 25, 2, '2026-09-18 15:00:00+00', false, true, 2, 'pack-2026_Panini_NFT_Bad_Eggs__The_Teams_of_New_Yolk_City_Packs', 17964, 0, '{timeline}', '2026-11-08 22:05:00+00', '2026-11-08 22:05:00+00'),
  ('1051', '2026 Panini NFT Prizm World Cup Animal Print Soccer Packs', 'SOCCER', 0, 2, '2026-09-09 15:00:00+00', false, false, 2, NULL, 600, 0, '{timeline}', '2026-11-08 22:05:00+00', '2026-11-08 22:05:00+00'),
  ('1050', '2026 Panini NFT Prizm World Cup Floral Soccer Packs', 'SOCCER', 0, 2, '2026-09-02 15:00:00+00', false, false, 2, NULL, 465, 0, '{timeline}', '2026-11-08 22:05:00+00', '2026-11-08 22:05:00+00'),
  ('1049', '2026 Panini NFT Moonbirds - Birbs Beyond Packs', 'ENTERTAINMENT', 50, 2, '2026-07-31 15:00:00+00', false, true, 2, NULL, 3873, 0, '{timeline}', '2026-11-08 22:05:00+00', '2026-11-08 22:05:00+00')
ON CONFLICT (pack_id) DO NOTHING;
