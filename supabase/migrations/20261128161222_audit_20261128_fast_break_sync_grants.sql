grant execute on function public.fast_break_ingest_topshot(jsonb) to service_role;
grant execute on function public.fast_break_parse_targets(text) to service_role;
grant select, insert, update on public.fast_break_topshot_cards to service_role;