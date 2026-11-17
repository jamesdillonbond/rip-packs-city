-- Cap three edition-page read RPCs at statement_timeout=8s so they can't hold a
-- pooler connection for the full service_role 30s default under saturation.
-- Their same-page siblings (get_edition_detail / _recent_sales / _fmv_history) are
-- already deliberately capped at 8s; these three inherited the 30s default, so on
-- the edition page the slowest connection-holder was 30s, undermining the 8s
-- protection on the rest. Warm latency measured 2026-08-05: market_bundle 132ms,
-- insight_links 41ms, special_serials sub-second — ~60x headroom under 8s, so this
-- never fires in normal operation; it only bites (fail-fast, freeing the connection)
-- when the DB is already saturated. Config-only ALTER; function bodies + search_path
-- are preserved. Revert: SET each back to '30s' (or RESET statement_timeout to fall
-- through to the service_role default).
alter function public.get_edition_market_bundle(uuid, text) set statement_timeout = '8s';
alter function public.get_edition_insight_links(uuid, text) set statement_timeout = '8s';
alter function public.get_edition_special_serials(uuid) set statement_timeout = '8s';
