# Handoff 2026-06-17 — Finish per-edition FMV ("watch this edition") alerts

Plain text. Claude Code's direct file inspection wins over this doc.

## Context

The FMV-alert backend is wired EXCEPT the creation UI, and there's an `alert_type` vocabulary mismatch that would silently break it.

- `dispatch_triggered_fmv_alerts` (called by the alerts-dispatch cron) reads `fmv_alerts`, evaluates, and enqueues `alert_kind='fmv'` deliveries; the senders + formatter already render `FmvPayload`. So dispatch + send + render are DONE.
- BUT the dispatcher checks `alert_type IN ('price_below','fmv_below','fmv_above','discount_above')`, while the only `fmv_alerts` CRUD route (`app/api/alerts/route.ts`, dormant) WRITES `alert_type IN ('below_fmv_pct','below_price')`. Mismatch — an alert created via that route would never trigger.
- AND the new `/alerts` page is deal-only (no FMV-alert UI; grep-confirmed).

## Two parts

1. Reconcile `alert_type` to ONE vocabulary. Recommend the dispatcher's set (`price_below` / `fmv_below` / `fmv_above` / `discount_above`) since that's what actually fires; update `app/api/alerts/route.ts` POST validation (and the GET's `currently_triggered` preview at lines ~110-113, which uses `below_fmv_pct`/`below_price`) to match. (Or migrate the dispatcher — either way, make them agree and pick names that read well in the UI.)

2. Build the "watch this edition" UI. Minimal version:
   - An "Alert me" control on the moment + edition pages (`app/moment/[id]/page.tsx`, `app/(collections)/[collection]/edition/[slug]/page.tsx`) that POSTs to `/api/alerts`: { edition_key, player_name, set_name, alert_type, threshold, channel } — owner_key resolved server-side from the session, NEVER body input (same invariant as the deal subs).
   - A "Watched editions" section on `/alerts` listing the user's `fmv_alerts` (GET `/api/alerts?owner_key=`) with edit/delete, kept visually distinct from deal alerts.

## UI copy distinction (so the two don't blur)

- Deal alerts = "tell me when ANY moment matching these filters gets cheap" (discovery; what's live today).
- FMV alerts = "watch THIS edition and ping me at a target price / FMV" (a specific watch).

## Verify

Create an FMV alert on a moment page -> confirm it lands in `fmv_alerts` with the reconciled `alert_type` -> run `/api/cron/alerts-dispatch` -> confirm it enqueues an `fmv` delivery when the threshold is met -> confirm the channel renders it.

## Revert

Remove the UI; revert the `alert_type` change.

## Product note for Trevor

This is the one item that's a genuine net-new build (UI on two page types) vs. a config/data fix. The serial + edition deal alerts already cover "tell me when something's cheap." FMV alerts add the narrower "watch this one edition for a target." Worth confirming it's wanted before CC spends the build time — flagged because you said "do it all," but it's the most optional of the four.
