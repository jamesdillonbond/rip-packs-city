-- UFC studio-platform sales-history backfill: single-row cursor state.
--
-- Unlike AllDay/Golazos/Pinnacle (per-edition queue driven by an edition_id
-- filter), the UFC studio GQL exposes NO edition filter — searchUFCMarketplace
-- History only filters by set_id/base_filter. So the UFC drain is a single
-- GLOBAL cursor walk over all ~860k purchased rows, sorted block_time ASC
-- (oldest first → new sales append at the tail, so the cursor stays stable
-- across ticks). Each row is resolved in-process to one of our 518 cataloged
-- editions via resolve_ufc_edition_by_studio_meta(athlete, edition_size)
-- (0 ambiguous keys; rows for uncataloged editions / packs resolve NULL → skip).
-- Matched rows are written to `sales` (source='ufc_studio_history_v1'), dedup by
-- transaction_hash → augments the forward indexer, never doubles.
--
-- This table holds the resumable walk position + running counters. Singleton row.
-- Applied live 2026-06-25 via apply_migration; this file is the repo-parity copy.
-- Revert: DROP TABLE public.ufc_studio_sales_history_state;
--         DELETE FROM sales WHERE source='ufc_studio_history_v1';
CREATE TABLE IF NOT EXISTS public.ufc_studio_sales_history_state (
  id              integer PRIMARY KEY DEFAULT 1,
  after_cursor    text,
  pages_walked    bigint NOT NULL DEFAULT 0,
  rows_scanned    bigint NOT NULL DEFAULT 0,
  rows_matched    bigint NOT NULL DEFAULT 0,
  sales_inserted  bigint NOT NULL DEFAULT 0,
  studio_total    bigint,
  last_block_time timestamptz,
  done            boolean NOT NULL DEFAULT false,
  error           text,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ufc_studio_state_singleton CHECK (id = 1)
);

INSERT INTO public.ufc_studio_sales_history_state (id) VALUES (1)
  ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.ufc_studio_sales_history_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.ufc_studio_sales_history_state FROM anon, authenticated;

COMMENT ON TABLE public.ufc_studio_sales_history_state IS
  'Singleton cursor state for the UFC studio-platform sales-history global walk (ufc-studio-sales-history-backfill). RLS-on, service_role only.';
