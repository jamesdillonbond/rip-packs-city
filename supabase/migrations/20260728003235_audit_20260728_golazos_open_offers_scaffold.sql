-- Inert scaffolding for a Golazos on-chain offers indexer (mirrors allday_open_offers).
-- The route /api/golazos-offers-indexer stays uncronned until an on-chain recon
-- confirms Golazos DapperOffersV2 offers are EDITION-type. Deny-all (RLS on + no
-- policy + explicit revoke); service_role bypasses RLS for the indexer writes.
-- Revert: DROP TABLE public.golazos_open_offers; DELETE FROM public.event_cursor WHERE id='golazos_offers';
CREATE TABLE IF NOT EXISTS public.golazos_open_offers (
  offer_id   text PRIMARY KEY,
  edition_id text NOT NULL,
  amount     numeric NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_golazos_open_offers_edition ON public.golazos_open_offers (edition_id);
ALTER TABLE public.golazos_open_offers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.golazos_open_offers FROM anon, authenticated;

INSERT INTO public.event_cursor (id, last_processed_block)
VALUES ('golazos_offers', 0)
ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE public.golazos_open_offers IS 'Live open DapperOffersV2 EDITION offers for LaLiga Golazos (offer_id -> edition_id, amount). Fed by /api/golazos-offers-indexer; INERT (no cron) until on-chain EDITION-type recon confirms + cron is wired. See docs/handoff-2026-07-28-golazos-offers-indexer.md.';