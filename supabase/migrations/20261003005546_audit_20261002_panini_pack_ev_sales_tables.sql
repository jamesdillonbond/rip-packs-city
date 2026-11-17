-- audit_20261002_panini_pack_ev_sales_tables
--
-- Storage for the 2026 Prizm WNBA (setId 2420) sales-based pack-EV model (see
-- 20261003010736_audit_20261002_panini_pack_ev_wnba_sales_model.sql for the why):
--   panini_pack_ev_sales_parallels - one row per parallel: its price for an average player, n sales,
--                                    and whether it was imputed (same family + print run / scarcity floor).
--   panini_pack_ev_sales_families  - one row per card family: mean and typical value of a pull from the
--                                    remaining pool, sales count, retransformation factor, log RMSE.
-- Service-role read only (RLS on, no policies); written by the SECURITY DEFINER refresh function.
--
-- REVERT: DROP TABLE public.panini_pack_ev_sales_families, public.panini_pack_ev_sales_parallels;
--         (after the board and the model view that read them are reverted.)

CREATE TABLE IF NOT EXISTS public.panini_pack_ev_sales_parallels (
  product_set_id int NOT NULL,
  parallel       text NOT NULL,
  fam            text NOT NULL,
  mint_cap       int,
  n_sales        int NOT NULL,
  avg_player_price numeric NOT NULL,
  imputed        text,
  computed_at    timestamptz NOT NULL,
  PRIMARY KEY (product_set_id, parallel)
);
CREATE TABLE IF NOT EXISTS public.panini_pack_ev_sales_families (
  product_set_id int NOT NULL,
  fam            text NOT NULL,
  n_sales        int NOT NULL,
  remain         bigint NOT NULL,
  smear          numeric NOT NULL,
  mean_value     numeric,
  typical_value  numeric,
  log_rmse       numeric,
  computed_at    timestamptz NOT NULL,
  PRIMARY KEY (product_set_id, fam)
);
ALTER TABLE public.panini_pack_ev_sales_parallels ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.panini_pack_ev_sales_families ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.panini_pack_ev_sales_parallels, public.panini_pack_ev_sales_families FROM anon, authenticated;
GRANT SELECT ON public.panini_pack_ev_sales_parallels, public.panini_pack_ev_sales_families TO service_role;
