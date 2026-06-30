# Handoff 2026-06-17 — Give /alerts a front door (no nav entry today)

Plain text. Claude Code's direct file inspection wins over this doc.

## STATUS: SHIPPED (2026-06-17, commit `dd02047`). All three fixes landed — see below.

Implemented in `dd02047` ("feat(alerts): give /alerts a front door — nav + dashboard + deal-surface CTAs"):
- **#1 nav** — TopNav gained an auth-gated "Alerts" link (signed-in only, like My Teams). MobileNav is a fixed 5-tab collection-scoped bar with no clean global slot, so desktop nav + the dashboard card carry mobile discoverability instead.
- **#2 dashboard** — `/dashboard` gained a header quick-link + a dedicated "Set up alerts" CTA card.
- **#3 deal surfaces** — `/insights/deals` (public Below-FMV board) "Alert me on deals like these" CTA, plus an "Alert me" chip on the collection sniper + market headers.

All CTAs point at the auth-gated `/alerts`; anon clicks bounce to `/login` by design. Nothing left to do.

---
### Original handoff (for reference)

## The gap

The entire alert system — deal / serial / per-edition FMV alerts, channel linking, watched editions — lives at `/alerts`, but NOTHING in the site navigation links to it. Grep-confirmed across `*.ts` + `*.tsx`: the only in-app link to the `/alerts` PAGE is the WatchEdition button's helper text on moment/edition pages (`components/alerts/WatchEditionButton.tsx`). Every other `/alerts` hit is an `/api/alerts/*` route or a "Manage at rippackscity.com/alerts" string in the bot/email senders — which only reach users who ALREADY have alerts. A new logged-in user browsing the site cannot discover the feature.

## Fix

1. Add an "Alerts" item to the primary navigation — the global nav component that already carries Dashboard / Insights / Pricing (likely a TopNav + MobileNav pair; the `/alerts` page itself already uses `MobileNav`, so mirror its other entries). Auth-gated, same as `/dashboard`. A bell icon reads instantly.
2. Add an "Alerts" card/CTA on `/dashboard` ("Get pinged when a moment drops below FMV — set up alerts") so logged-in users find it from their home surface.
3. Optional, high-intent: a "Set an alert for this" CTA on the sniper / market / insights deal surfaces, where a user looking at deals would naturally want to be notified. (#1 is the essential one; this is gravy.)

## Verify

Logged in, the Alerts entry appears in the nav (desktop + mobile) and routes to `/alerts`; logged out it follows the same gate as the other authed nav items.

## Note for Trevor (this might be intentional)

If `/alerts` is unlinked on purpose — i.e. you plan to surface it as the deliberate "launch" of the alerts feature once it's settled — then this is a sequencing choice, not a bug, and there's nothing to do until then. Flagging it because a just-built feature with no entry point is usually an oversight, not a decision. Your call whether CC adds the nav entry now or you hold it for launch.
