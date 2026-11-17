-- Golazos studio-platform sales-history backfill: per-edition progress queue + seed fn.
-- Drives app/api/cron/golazos-studio-sales-history-backfill (lib/studio-sales-history.ts).
-- Applied live 2026-06-25 (audit_20260624_golazos_studio_sales_history_progress);
-- this is the repo-parity copy. Revert: DROP TABLE ... CASCADE; DROP FUNCTION ...
CREATE TABLE IF NOT EXISTS public.golazos_studio_sales_history_progress (
  edition_id uuid NOT NULL,
  external_id text NOT NULL,
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
  PRIMARY KEY (edition_id)
);
ALTER TABLE public.golazos_studio_sales_history_progress ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.golazos_studio_sales_history_progress FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.seed_golazos_studio_sales_history_targets()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_count integer;
begin
  insert into public.golazos_studio_sales_history_progress (edition_id, external_id, priority)
  select e.id, e.external_id,
         case when not exists (select 1 from sales s where s.edition_id = e.id) then 1 else 3 end
  from editions e
  where e.collection_id = '06248cc4-b85f-47cd-af67-1855d14acd75'
    and e.external_id ~ '^\d+$'
    and not exists (select 1 from public.golazos_studio_sales_history_progress p where p.edition_id = e.id)
  on conflict (edition_id) do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end;
$function$;
