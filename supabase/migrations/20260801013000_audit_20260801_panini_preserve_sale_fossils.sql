-- audit_20260801_panini_preserve_sale_fossils
--
-- Panini upstream stopped supplying brought_at_price/brought_at_time on 2026-07-29
-- (values went from "0"-or-number to JSON null; the KEY is still present every day).
-- The ingest does a full-row .upsert(onConflict:"sku") -- app/api/cron/panini-ingest/route.ts:86,
-- value from lib/chains/panini/ingest-normalize.ts:101 posOrNull(p?.brought_at_price) --
-- so every re-walk of a previously-priced serial OVERWRITES its sale record with null.
-- These values are NOT recoverable from `raw`: they were never delivered.
--
-- panini_card_serials is upsert-keyed on sku, so captured_at is the LATEST walk, not
-- first-seen. All 3,925 surviving priced serials had captured_at <= 2026-07-28 21:26 --
-- every one a fossil awaiting re-walk. At ~7.7k serials/day against a 49,179 corpus the
-- remaining ~18.3k un-rewalked serials get covered in ~2-3 days, so the dataset was not
-- "frozen", it was draining to zero. This migration archives what survived and stops it.

-- 1) Immutable insurance snapshot of every surviving sale record.
CREATE TABLE IF NOT EXISTS public.panini_card_serial_sale_fossils (
  sku            text PRIMARY KEY,
  last_sale_usd  numeric     NOT NULL,
  last_sale_at   timestamptz,
  captured_at    timestamptz NOT NULL,
  archived_at    timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.panini_card_serial_sale_fossils IS
  'Insurance snapshot of Panini serial sale records that survived the 2026-07-29 upstream '
  'supply outage. Upstream stopped sending brought_at_price values; the full-row upsert in '
  'app/api/cron/panini-ingest was overwriting stored prices with null on each re-walk. '
  'These values cannot be re-fetched. Read-only archive; the live column is protected by '
  'trg_panini_preserve_sale_fields.';

INSERT INTO public.panini_card_serial_sale_fossils (sku, last_sale_usd, last_sale_at, captured_at)
SELECT sku, last_sale_usd, last_sale_at, captured_at
  FROM public.panini_card_serials
 WHERE last_sale_usd IS NOT NULL AND sku IS NOT NULL
ON CONFLICT (sku) DO NOTHING;

ALTER TABLE public.panini_card_serial_sale_fossils ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.panini_card_serial_sale_fossils FROM anon, authenticated;

-- 2) Mark preserved values so a fossil is always distinguishable from a fresh read.
--    Without this the coverage view's mapping_shortfall (= raw_supplied - column_filled)
--    would go NEGATIVE, silently inverting the "upstream vs us" split it exists to provide.
ALTER TABLE public.panini_card_serials
  ADD COLUMN IF NOT EXISTS last_sale_preserved_at timestamptz;

COMMENT ON COLUMN public.panini_card_serials.last_sale_preserved_at IS
  'Set when trg_panini_preserve_sale_fields retained a prior last_sale_usd/_at because the '
  'incoming upstream payload carried null. NULL => last_sale_usd reflects the payload of the '
  'walk named by captured_at. NOT NULL => the value is a fossil from an earlier walk.';

-- 3) Never let a null payload erase a known sale. Sales do not un-happen, so retaining is
--    strictly more truthful than nulling. Fresh non-null values still overwrite normally.
CREATE OR REPLACE FUNCTION public.panini_preserve_sale_fields()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF NEW.last_sale_usd IS NULL AND OLD.last_sale_usd IS NOT NULL THEN
    NEW.last_sale_usd          := OLD.last_sale_usd;
    NEW.last_sale_at           := OLD.last_sale_at;
    NEW.last_sale_preserved_at := COALESCE(OLD.last_sale_preserved_at, now());
  ELSIF NEW.last_sale_usd IS NOT NULL THEN
    NEW.last_sale_preserved_at := NULL;  -- a real value arrived; no longer a fossil
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_panini_preserve_sale_fields ON public.panini_card_serials;
CREATE TRIGGER trg_panini_preserve_sale_fields
  BEFORE UPDATE ON public.panini_card_serials
  FOR EACH ROW EXECUTE FUNCTION public.panini_preserve_sale_fields();

-- 4) Keep the coverage view's diagnostic split valid now that fossils exist.
--    New columns appended LAST: CREATE OR REPLACE VIEW cannot reorder or rename existing
--    columns (inserting preserved_fossils mid-list fails with 42P16).
CREATE OR REPLACE VIEW public.v_panini_serial_sale_field_supply AS
SELECT captured_at::date AS capture_day,
       count(*) AS serials_captured,
       count(*) FILTER (WHERE NULLIF(NULLIF(raw ->> 'brought_at_price', ''), '0') IS NOT NULL) AS raw_supplied_sale_price,
       count(*) FILTER (WHERE NULLIF(raw ->> 'brought_at_time', '') IS NOT NULL) AS raw_supplied_sale_time,
       count(*) FILTER (WHERE last_sale_usd IS NOT NULL) AS column_last_sale_usd,
       round(100.0 * count(*) FILTER (WHERE NULLIF(NULLIF(raw ->> 'brought_at_price', ''), '0') IS NOT NULL)::numeric
             / NULLIF(count(*), 0)::numeric, 2) AS pct_upstream_supplied,
       -- Shortfall is measured ONLY over rows whose column reflects this walk's payload;
       -- preserved fossils are excluded so >0 still means exactly "our mapping dropped it".
       count(*) FILTER (WHERE NULLIF(NULLIF(raw ->> 'brought_at_price', ''), '0') IS NOT NULL)
         - count(*) FILTER (WHERE last_sale_usd IS NOT NULL AND last_sale_preserved_at IS NULL) AS mapping_shortfall,
       count(*) FILTER (WHERE last_sale_preserved_at IS NOT NULL) AS preserved_fossils
  FROM public.panini_card_serials s
 WHERE captured_at > (now() - '30 days'::interval)
 GROUP BY captured_at::date;

ALTER VIEW public.v_panini_serial_sale_field_supply SET (security_invoker = on);
REVOKE ALL ON public.v_panini_serial_sale_field_supply FROM anon, authenticated;

COMMENT ON VIEW public.v_panini_serial_sale_field_supply IS
  'Panini serial sale-field supply by capture day. Separates "upstream stopped sending" '
  '(pct_upstream_supplied collapses) from "we stopped parsing" (mapping_shortfall > 0) — '
  'different owners, different fixes. Root cause 2026-07-29: upstream brought_at_price went '
  'from "0"-or-number to JSON null for every serial. preserved_fossils counts rows whose '
  'last_sale_usd was retained by trg_panini_preserve_sale_fields against a null payload.';
