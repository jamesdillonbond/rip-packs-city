# Handoff 2026-06-16 — Discord embed thumbnail fix (one-liner)

Plain text (iPhone-pasteable). Claude Code's direct file inspection wins over this doc on any disagreement.

## Context

The omni-channel alerts are now LIVE-VERIFIED end to end on all three channels (real test against Trevor's account, 2026-06-16/17 UTC): email linked + verified; Telegram delivered a 9-deal digest (9/9 sent); Discord delivered an 8-deal embed digest (8/8 sent). Bots, identity linking, dispatcher, outbox, and per-channel senders all work. One defect surfaced during the Discord test — this handoff is just that fix.

## Bug

A deal digest that includes a Pinnacle deal fails to send on Discord. The sender logs `discord msg 400: {"message":"Invalid Form Body","code":50035,"errors":{"embeds":{"N":{"thumbnail":{"url":{"_errors":[{"code":"URL_TYPE_INVALID_URL","message":"Not a well formed URL."}]}}}}}}` and `alert_deliveries.last_error` carries the same; the whole batch (all embeds in that grouped message) marks failed.

Root cause: Pinnacle rows from `cross_collection_deals_board` carry a RELATIVE `thumbnail_url` (`/api/public/pinnacle-image/<render_id>`). Discord requires an ABSOLUTE URL for an embed thumbnail and rejects the entire message payload if any one embed is malformed. Top Shot rows have a null `thumbnail_url` (omitted, fine). Telegram and email don't put the thumbnail in a strict-URL field, so they were unaffected — Telegram delivered the same digest (including the Pinnacle deal) cleanly.

## Fix (one line)

File: lib/alerts/format.ts, function buildDiscordEmbeds.

Current line:
  thumbnail: deal.thumbnail_url ? { url: deal.thumbnail_url } : undefined,

Change to:
  thumbnail: deal.thumbnail_url ? { url: absUrl(deal.thumbnail_url) } : undefined,

`absUrl()` already exists in this file (alongside `const SITE = "https://www.rippackscity.com"`, ~line 28) and is exactly what the embed's `title` `url` and the Telegram/email links already use — it prefixes a relative path with the site origin and leaves an already-absolute URL untouched. No other change. (Optional hardening, not required: also guard against a non-`/`, non-`http` value, but every current source is either null or a `/…` path, so the absUrl wrap is sufficient.)

## Verify

After deploy: stage a deal subscription whose matches include a Pinnacle deal (e.g. min_discount ~25 with collection_ids null), run `/api/cron/alerts-dispatch`, then `/api/cron/alerts-send?channel=discord` with Bearer INGEST. Confirm the Pinnacle delivery row flips to `sent` (not `failed` with 50035) and the DM arrives with its thumbnail.

## Revert

Drop the `absUrl(...)` wrapper (back to `{ url: deal.thumbnail_url }`).

## Guardrails

Direct to main, no PR. Commit via PowerShell git; re-verify push with `git rev-list --count origin/main..HEAD` == 0. `npx tsc --noEmit` clean. Log the fix in docs/overnight/ledger.md + CLAUDE.md (Cowork didn't, to avoid the ledger-truncation hazard).

## Expected end state

One commit on main, deploy READY; a Pinnacle-containing deal digest delivers to Discord without 50035. This was the only gap from the all-three-channels live test — with it, Discord deal alerts cover every collection.
