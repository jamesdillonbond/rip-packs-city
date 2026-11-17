-- One-shot correction of the rows already in the table; the route fix that stops writing them
-- ships in the same push (app/api/topshot-listing-cache/route.ts).
--
-- Flowty answers with a PLACEHOLDER title — literally `TopShot #<nftId>` — and NO traits for any
-- NFT whose metadata it has not resolved. That title is truthy, so it passed the route's
-- `!playerName` guard and landed a row that read as a Moment and was fabricated end to end.
-- MEASURED over the whole live population, not a sample — 70 of 104 Top Shot rows were
-- placeholders, and for **70 OF 70**:
--   • `serial_number` = the NFT ID (Flowty's `card.num` on an unresolved NFT), so the row published
--     a serial nobody holds — `#52,313,854`;
--   • `tier` = 'COMMON', supplied by the route's `?? "COMMON"` default, never read;
--   • `set_name` / `series_name` / `circulation_count` / `thumbnail_url` all absent;
--   • Flowty's blended valuation still landed in `fmv`, and on **9 of them the ask was BELOW it**,
--     so the row rendered as a DISCOUNT on an NFT we cannot identify.
--
-- ⭐ THE PUBLISHED CONSEQUENCE, with a positive control. `/api/profile/market-pulse` groups
-- `cached_listings` by `tier` and takes the lowest ask as the collector's floor. Split by identity:
--     resolved   34 rows, COMMON, min ask **$0.20**   ← the true floor
--     unresolved 70 rows, COMMON *by default*, min ask **$0.19**   ← what we published
-- The dollar gap is small only because this book is cheap. The mechanism is not: an assumed tier
-- sets a published floor, so one unresolved LEGENDARY listed at $2 becomes the COMMON floor.
--
-- NULL is the honest value and the safe one: market-pulse buckets `String(tier ?? "")`, so a NULL
-- tier can never become a floor, and All Day already carries a NULL-tier row today with nothing
-- downstream breaking — the column is nullable and tolerated. The LISTING is kept: `flow_id`,
-- `ask_price`, `buy_url` and `listed_at` are real and feed the wallet-search low-ask map.
--
-- ⚠ SCOPE, deliberately narrow. `app/api/listing-cache/route.ts` (All Day / Golazos / UFC) carries
-- the identical `|| "COMMON"` fabrication, and it is NOT touched here because it is not exposed:
-- across those collections exactly **1 of 201** rows arrived without traits, and it already stores
-- a NULL tier. The instrument for the next pass is `set_name IS NULL` = "Flowty sent no traits";
-- if that count ever rises there, the same fix applies. Shipping a blind change to a route whose
-- defect I could not measure is the mistake this project keeps writing down.
-- anon-exec: n/a — data-only UPDATE, no function created or altered.
-- REVERT: UPDATE public.cached_listings cl SET tier = a.old_tier, serial_number = a.old_serial,
--           fmv = a.old_fmv FROM public.audit_20260904_unidentified_listings a WHERE a.flow_id = cl.flow_id
--           AND cl.collection_id = a.collection_id;
--         plus `git revert` of the route + test change.

CREATE TABLE IF NOT EXISTS public.audit_20260904_unidentified_listings (
  flow_id       text NOT NULL,
  collection_id uuid NOT NULL,
  player_name   text,
  old_tier      text,
  old_serial    integer,
  old_fmv       numeric,
  applied_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (flow_id, collection_id)
);
ALTER TABLE public.audit_20260904_unidentified_listings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.audit_20260904_unidentified_listings FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.audit_20260904_unidentified_listings TO postgres, service_role, cron_heavy;

WITH cand AS (
  SELECT cl.flow_id, cl.collection_id, cl.player_name, cl.tier, cl.serial_number, cl.fmv
    FROM public.cached_listings cl
   WHERE cl.collection_id = '95f28a17-224a-4025-96ad-adf8a4c63bfd'::uuid
     -- the placeholder is the collection name plus THIS row's own nft id, never a loose pattern
     AND cl.player_name = 'TopShot #' || cl.flow_id
),
logged AS (
  INSERT INTO public.audit_20260904_unidentified_listings
    (flow_id, collection_id, player_name, old_tier, old_serial, old_fmv)
  SELECT flow_id, collection_id, player_name, tier, serial_number, fmv FROM cand
  ON CONFLICT (flow_id, collection_id) DO NOTHING
)
UPDATE public.cached_listings cl
   SET tier          = NULL,
       serial_number = NULL,
       fmv           = NULL
  FROM cand c
 WHERE cl.flow_id = c.flow_id AND cl.collection_id = c.collection_id;
