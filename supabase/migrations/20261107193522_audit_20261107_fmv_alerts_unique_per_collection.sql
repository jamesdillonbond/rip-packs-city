-- 2026-11-07 (PT) — fmv_alerts: the upsert key forgets the collection.
--
-- POST /api/alerts upserts on (owner_key, edition_key, alert_type) — the table's
-- UNIQUE constraint — but edition keys are shared ACROSS collections (a Top Shot
-- "setId:playId" and an All Day integer key can collide, and CLAUDE.md: a key is
-- unique only within a collection). So a price_below alert on an All Day edition
-- whose key equals a Top Shot one the collector already watched OVERWROTE the Top
-- Shot row's collection_id, threshold and channel, and that alert vanished with no
-- message (fresh-eyes review of lib/alerts + app/api/alerts, 2026-11-07).
--
-- FIX: the key carries collection_id. NULLS NOT DISTINCT so an alert with no
-- collection still conflicts with itself (the column is nullable) — the old key's
-- behaviour for that row, kept. Measured before applying: fmv_alerts holds 0 rows,
-- so no existing row can violate the new key and none is rewritten. No function
-- names the old constraint (prosrc grep for ON CONFLICT on fmv_alerts: none); the
-- one writer is app/api/alerts/route.ts, whose onConflict moves in the same commit.
--
-- Revert:
--   ALTER TABLE public.fmv_alerts DROP CONSTRAINT fmv_alerts_owner_coll_edition_type_unique;
--   ALTER TABLE public.fmv_alerts ADD CONSTRAINT fmv_alerts_owner_edition_type_unique
--     UNIQUE (owner_key, edition_key, alert_type);
--   (and the route's onConflict back to "owner_key,edition_key,alert_type")

ALTER TABLE public.fmv_alerts DROP CONSTRAINT fmv_alerts_owner_edition_type_unique;
ALTER TABLE public.fmv_alerts ADD CONSTRAINT fmv_alerts_owner_coll_edition_type_unique
  UNIQUE NULLS NOT DISTINCT (owner_key, collection_id, edition_key, alert_type);
