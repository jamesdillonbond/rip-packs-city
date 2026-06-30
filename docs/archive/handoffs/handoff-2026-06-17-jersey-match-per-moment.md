# Handoff 2026-06-17 — Jersey-match must use the per-MOMENT jersey, not the player's current number

Plain text. Claude Code's direct file inspection wins over this doc. This is a CORRECTNESS fix, not just the alert filter — it affects the jersey-match special-serial everywhere.

## The bug (Trevor caught it)

`get_edition_special_serials` derives the "jersey" tag from `players.jersey_number`, joined via `editions.player_id`:
  LEFT JOIN public.players p ON p.id = e.player_id ... SELECT ed.jersey_number::int, 'jersey' ...
The new serial-alert filter `require_jersey_serial` in `topshot_serial_deal_alerts_for_subscription` does the same (compares serial to `players.jersey_number`).

`players.jersey_number` is a SINGLE value per player (current / last-known), applied to every edition of that player. Players change teams and numbers, and Top Shot's own "jersey match" is the number worn in THAT specific moment. So a moment where the player wore #30 should match serial #30 even if he wears #3 today — the current logic matches #3 across all his moments. Wrong for every number-changer.

## Correct source

The per-moment jersey number, which Top Shot carries in the play/moment metadata (it computes jersey-match itself). RPC does NOT store it — there is no edition-level jersey column (confirmed: the only jersey columns are `players.jersey_number`, the empty `nba_players.jersey_number`, and a `v_ultimate_fmv_state` projection of players). So this needs to be captured from Top Shot.

## Fix (CC + ingest — needs TS GQL, not Cowork-shippable)

1. Add `editions.jersey_number smallint` (nullable) — the jersey worn in that edition's play.
2. Capture it in the TS edition/play ingest. CONFIRM the GQL field first — the play/moment stats should carry the jersey number (the ingest already pulls play_type/play_category/game_date, so add the jersey field alongside). Backfill historical editions via a `searchEditions` / play-metadata re-fetch.
3. Switch BOTH consumers from `players.jersey_number` to `editions.jersey_number`:
   - `get_edition_special_serials`: use the edition's own jersey; drop the players join for the jersey tag.
   - `topshot_serial_deal_alerts_for_subscription` (require_jersey_serial): join editions on `b.external_id` and compare `b.serial_number = e.jersey_number`.
4. Validate against a known jersey-match moment for a player who changed numbers — confirm RPC now matches Top Shot's own jersey-match badge.

## Interim

Until this lands, the jersey filter and the special-serials jersey tag are APPROXIMATE: correct for stable-number players, wrong for number-changers, and capped at the ~29% of players that have any `players.jersey_number`. Either note the approximation in the UI or hold the jersey filter as "coming soon" — your call.

## Revert

Keep `editions.jersey_number`; revert the two functions to `players.jersey_number`.
