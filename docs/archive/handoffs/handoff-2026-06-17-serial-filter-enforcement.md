# Handoff 2026-06-17 — Enforce the remaining serial-deal filters (team / jersey / never-sold / badges)

Plain text. Claude Code's direct file inspection wins over this doc.

## Context

The serial deal dispatcher `topshot_serial_deal_alerts_for_subscription` (DB fn) reads `topshot_underpriced_serials_board` and ENFORCES: estimate_quality=tight, min_discount, min/max_price, tiers, player_names, set_names, min/max_serial, require_last_mint (serial==circulation_count). Its own `unenforced_filters` return array lists what is NOT enforced: require_jersey_serial, require_never_sold, require_low_ask, badges, team_names. The `/alerts` UI saves these but they don't filter. This enforces the feasible ones. Each is a WHERE-clause addition in that fn (CREATE OR REPLACE; keep it SECURITY DEFINER, search_path public/pg_temp, service_role-only grants; update the enforced/unenforced arrays as you move each).

## Items (easiest first)

1. team_names — EASY, do first. Board has `external_id` (int-pair) but no team; join editions:
   AND (v_sub.team_names IS NULL OR EXISTS (SELECT 1 FROM public.editions e WHERE e.external_id=b.external_id AND e.collection_id='95f28a17-224a-4025-96ad-adf8a4c63bfd' AND lower(e.team_name)=ANY(ARRAY(SELECT lower(x) FROM unnest(v_sub.team_names) x))))
   `editions.team_name` is populated. Clean.

2. require_jersey_serial — serial_number == the player's jersey number.
   CAVEAT (measured): `players.jersey_number` is only 18.9% populated (1,256 / 6,650 players), so this filter can only ever fire for ~1 in 5 players. The board carries player_name (no player_id), so resolve via players by (lower(name), collection) — fragile for duplicate names; cleaner to add player_id to the board, else accept the name match:
   AND (NOT COALESCE(v_sub.require_jersey_serial,false) OR EXISTS (SELECT 1 FROM public.players p WHERE p.collection_id='95f28a17-…' AND lower(p.name)=lower(b.player_name) AND p.jersey_number=b.serial_number))
   To raise coverage, backfill players.jersey_number (TS GQL player metadata or a sports-data source) — separate data task; note the ~19% ceiling in the UI so users aren't surprised.

3. require_never_sold — "this specific serial has never sold".
   AND (NOT COALESCE(v_sub.require_never_sold,false) OR NOT EXISTS (SELECT 1 FROM public.sales s WHERE s.<moment-id col> = b.nft_id))
   CONFIRM FIRST: which `sales` column carries the moment/NFT id the board uses (`nft_id`). If `sales` doesn't key by that id, this needs the moment->sales mapping before it can be written. Verify against a known sold serial before shipping.

4. badges — join the edition's badges (get_edition_badges_unified / badge_editions) and match v_sub.badges. Lower priority; confirm the board edition->badge join key.

5. require_low_ask — leave unenforced and drop it from the UI: the board rows are already underpriced asks, so it's redundant/always-true.

## Verify

Stage a sub with each filter set, dispatch (`dispatch_due_deal_alerts`), confirm the deal set narrows correctly — especially that a jersey filter returns only serial==jersey rows, and team_names only that team.

## Revert

CREATE OR REPLACE the prior fn body.
