# Handoff 2026-06-18 — Surface the formal parallel/variant in alerts + optional filter (part 2 of the "parallel type" ask)

Plain text. Claude Code's direct file inspection wins over this doc.

## STATUS — display SHIPPED 2026-06-18; optional filter still deferred (Trevor's call)

Items 1 + 2 (source the formal parallel into the deal payload + render it in the alert line) are LIVE:
- Migration `dispatch_due_deal_alerts_surface_parallel_variant` adds a `parallel` key to both passes of `dispatch_due_deal_alerts`. TS (both passes, by `external_id`): `badge_editions.parallel_name` excluding `''`/`Standard`. Pinnacle (Pass 1, by `render_id`): `pinnacle_catalog.variant` excluding `Standard`. `parallel_type` is null platform-wide so `variant` is the source. Verified live: Pinnacle deals resolve "Brushed Silver"/"Color Splash"/"Colored Enamel"/"Embellished Enamel"/"Golden"; base/Standard → null. CREATE OR REPLACE (grants preserved). Revert: re-CREATE the prior body (no `parallel` key).
- `lib/alerts/format.ts` `dealSubline` now renders `parallel` after the set name: "#1 · Rare · Set · Diced · /222 · Collection". `dealParallel` no-ops on null. `parallel: string | null` added to `DealPayload["deal"]` in `lib/alerts.ts`.

Item 3 (parallel filter) — SHIPPED 2026-06-18. Migration `alert_subscriptions_parallel_names_filter` adds `alert_subscriptions.parallel_names text[]` (nullable = no filter) and wires it into both passes of `dispatch_due_deal_alerts` + the `build_deal_alerts_for_subscription` preview. Match value mirrors the displayed parallel: TS named parallel from `badge_editions` (Galactic/Diced), Pinnacle variant from the board `tier` column (which holds the variant). NULL resolved value never matches, so setting the filter narrows out base editions. App: `parallel_names` accepted in the subscriptions API sanitizer + a chip multi-select on `/alerts` (15 Pinnacle variants + Galactic/Diced). Verified live: a `Golden`/`Color Splash` filter matches only those Pinnacle variants, TS base editions excluded. Revert: drop the column + re-CREATE both prior function bodies + drop the UI/API field. Whole part-2 ask now complete.

---

Original notes (data findings still hold; display is now shipped per the status block above).

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
