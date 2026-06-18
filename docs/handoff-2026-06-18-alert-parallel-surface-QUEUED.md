# Handoff 2026-06-18 — Surface the formal parallel/variant in alerts + optional filter (QUEUED — part 2 of the "parallel type" ask)

Plain text. Claude Code's direct file inspection wins over this doc. QUEUED — do part 1 (the tier+mint display handoff) first; this is the lower-yield follow-up Trevor wanted queued.

## Key finding (measured 2026-06-17, read this before building)

Top Shot's FORMAL parallel is ALREADY captured and is NOT an ingest gap:
- `badge_editions.parallel_id` / `parallel_name` is populated on all 10,893 rows by badge-sync. The values: 0/"" (8,937) + 0/"Standard" (1,953) + 21/"Galactic" (2) + 8/"Diced" (1). So 99.97% are base/Standard — most TS editions genuinely have NO named parallel. Only rare special treatments (Galactic, Diced, …) do.
- `ts_listings.parallel_id` is all 0; `editions` has no parallel column; `topshot_active_listings` (the serial-deal source) has no parallel column.
- So there is essentially nothing to "re-ingest" for Top Shot — badge-sync already captures parallel for every edition; it's just base for nearly all. Confirm once whether the TS editions-catalog GQL (`searchEditions`) exposes a richer parallel taxonomy than badge-sync stores; if not, TS parallel is DONE and this reduces to a display join.

Pinnacle is the opposite — the variant IS the core concept and is well-populated: `pinnacle_catalog.variant` / `parallel_type`, `pinnacle_editions.variant_type`. Surfacing it for Pinnacle deals is genuinely valuable; for TS it only ever shows on the rare Galactic/Diced editions.

## What to build

1. Add a `parallel` field to the deal payload in `dispatch_due_deal_alerts` (DB migration; CC can ship DB migrations — Part 2 of the scalability work was `audit_20260617_dispatch_due_deal_alerts_materialize_pools_once`). Source it per collection, real-values-only:
   - TS (both passes, keyed by `b.external_id`): `(SELECT NULLIF(be.parallel_name,'') FROM public.badge_editions be WHERE be.external_id = b.external_id AND be.parallel_name NOT IN ('','Standard') LIMIT 1)` — null for ~all, "Diced"/"Galactic" for the rare ones. (badge_editions has many rows per edition but parallel is per-edition, so LIMIT 1 is correct.)
   - Pinnacle (Pass 1 only; the cross board carries `render_id` for Pinnacle): pull `variant` / `parallel_type` from `pinnacle_catalog` by render_id. Confirm the join key against the board's Pinnacle rows first.
   Keep the new key additive (`'parallel', …`) so it's a harmless no-op until the formatter renders it.

2. Render it in `lib/alerts/format.ts` `dealSubline` — append after the set name when present, e.g. "Rare · Metallic Gold LE · Diced · /222". Add `parallel?: string | null` to the `Deal` type.

3. OPTIONAL — Parallel filter. Mirror the existing `set_names` pattern: add `alert_subscriptions.parallel_names text[]` (nullable), a multi-select in the /alerts UI, and a WHERE clause in both dispatcher passes (`v_sub.parallel_names IS NULL OR lower(<parallel source>) = ANY(...)`). Given TS sparsity this mostly matters for Pinnacle variants — Trevor's call whether it's worth the UI surface, or hold it until there's demand.

## Verify

Dispatch a sub that matches a known named-parallel edition (a Diced/Galactic TS edition, or any Pinnacle deal with a variant), confirm the alert line shows the parallel/variant; confirm a base TS deal still shows no parallel segment (null, not "Standard").

## Revert

Drop the `parallel` key from the dispatcher payload + the `dealSubline` segment; drop `parallel_names` if added.
