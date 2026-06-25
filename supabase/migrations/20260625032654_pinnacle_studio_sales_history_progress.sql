-- Pinnacle studio-platform sales-history backfill: per-render progress queue + seed fn.
-- Drives app/api/cron/pinnacle-studio-sales-history-backfill (render-keyed; writes
-- pinnacle_sales, NOT the shared `sales` table).
-- Applied live 2026-06-25 (audit_20260624_pinnacle_studio_sales_history_progress);
-- this is the repo-parity copy. Revert: DROP TABLE ... CASCADE; DROP FUNCTION ...
CREATE TABLE IF NOT EXISTS public.pinnacle_studio_sales_history_progress (
  render_id text NOT NULL,
  studio_edition_id text NOT NULL,
  legacy_edition_key text,
  priority smallint NOT NULL DEFAULT 3,
  status text NOT NULL DEFAULT 'pending'::text,
  attempts integer NOT NULL DEFAULT 0,
  last_attempt_at timestamp with time zone,
  sales_inserted integer NOT NULL DEFAULT 0,
  dupes_skipped integer NOT NULL DEFAULT 0,
  studio_total integer NOT NULL DEFAULT 0,
  gql_pages integer NOT NULL DEFAULT 0,
  error text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  PRIMARY KEY (render_id)
);
ALTER TABLE public.pinnacle_studio_sales_history_progress ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.pinnacle_studio_sales_history_progress FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.seed_pinnacle_studio_sales_history_targets()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_count integer;
begin
  insert into public.pinnacle_studio_sales_history_progress (render_id, studio_edition_id, legacy_edition_key, priority)
  select c.render_id, c.edition_id, c.legacy_edition_key,
         case when not exists (select 1 from pinnacle_sales s where s.render_id = c.render_id) then 1 else 3 end
  from pinnacle_catalog c
  where c.edition_id ~ '^\d+$'
    and c.render_id is not null
    and not exists (select 1 from public.pinnacle_studio_sales_history_progress p where p.render_id = c.render_id)
  on conflict (render_id) do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end;
$function$;
