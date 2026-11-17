# Handoff 2026-06-13 — UI cleanup batch (slabs, sniper, mobile toggle, pack-sniper tab)

Five front-end items from Trevor. All .tsx → Claude Code ships. Ordered easiest-first; Items D and E carry a small decision, flagged inline. File paths grep-verified.

## Item A — Remove collection name from trophy slabs (trivial)

File: components/TrophySlab.tsx → `SlabLabel`.
Delete the `{slab.collection_display_name && ( ... )}` block (the middle-column `<div>` that renders `slab.collection_display_name`, ~lines 402-415). Leave player name, play_description, set_name. Nothing else references it in the label.
Revert: restore the block. Verify: slab labels no longer show the collection name; text has more room (pairs with the just-shipped QR removal `e26502e`).

## Item B — Remove the "TS NATIVE" / "* NATIVE" source chip from sniper (trivial)

File: app/(collections)/[collection]/sniper/page.tsx.
The `SourceBadge` component (~lines 319-328) + `SOURCE_BADGE_STYLES` dict (~lines 311-317) render "TS NATIVE / ALLDAY NATIVE / GOLAZOS NATIVE / PINNACLE NATIVE / FLOWTY" chips on every deal. Post-Flowty everything is native, so the chip is pure noise. Remove the `<SourceBadge ... />` render call site(s) (grep `<SourceBadge` in the file — likely in both the desktop row and the mobile card). Optionally delete the now-unused `SourceBadge` + `SOURCE_BADGE_STYLES` to keep it clean (tsc will flag them unused).
Revert: re-add the render. Verify: sniper rows no longer show the NATIVE chip.

## Item C — Add the theme toggle to mobile nav (the "where is it?" fix)

The toggle (components/ThemeToggle.tsx, the sun/moon icon button) renders top-right of the desktop header (app/(collections)/layout.tsx `SiteHeader`, ~line 60) and in SiteFooter. On mobile it's effectively unreachable: the header row has `overflow: hidden` (~line 51) so the right-side controls (toggle/ProBadge/SignOut) clip off a narrow viewport, and components/MobileNav.tsx (the bottom tab bar) doesn't include it. So on a phone the only way to flip themes is scrolling to the footer — which is why Trevor can't find it.
Fix: surface ThemeToggle on mobile. Cleanest: add it to MobileNav — e.g., a small control in the Collections sheet header (components/MobileNav.tsx, the sticky sheet header ~lines 141-180, next to the COLLECTIONS title / close button), or as a 6th bottom-tab. (Don't fight the header `overflow:hidden` — the bottom nav is where mobile users look.)
Revert: remove it. Verify: on a <768px viewport, the theme toggle is visible and flips light/dark.

## Item D — Missing thumbnails on sniper (decision: fallback source)

Data check (2026-06-13): canonical (int-keyed) TS editions are 99.7% covered — only **28 of 9,137** have a null `thumbnail_url` (the 6,434 total nulls are almost all the inert UUID-keyed dupes, which never reach the sniper). So the gap users see is small and is one of two things:
1. those ~28 artless canonical editions, or
2. a thumbnail-resolution miss in the sniper feed — a live TS listing whose edition our `/api/sniper-feed` route didn't match to art (keying), so `deal.thumbnailUrl` comes back null.
The render already branches on `deal.thumbnailUrl ? <img> : <fallback>` (sniper page ~lines 1496 + 1695). CC: (a) inspect how `/api/sniper-feed` populates `thumbnailUrl` for TS deals and add a fallback when it's null — the on-chain IPFS asset (`topshot_ipfs_assets`, the media catalog completed 2026-06-10) or the moment's media — and (b) make the null-branch a clean branded placeholder (not an empty/black box). Verify against a sniper page: rows that were blank now show art or a tidy placeholder.

## Item E — Pack sniper as a collection tab (decision: scope)

Pack sniper currently lives at the global /insights/pack-sniper (app/insights/pack-sniper/, PackSniperClient.tsx). Trevor wants it as a collection tab alongside overview/collection/sniper/packs.
Tabs are data-driven: components/collection-tab-bar.tsx maps `collection.pages` (from lib/collections.ts) → `href = /{collection.id}/{page}`, labels from `PAGE_LABELS`. components/MobileNav.tsx `SHEET_PAGES` mirrors them for mobile.
Two ways, Trevor's call:
- **(Recommended) Per-collection route:** add a `pack-sniper` page to the collection(s) `pages` array + a `PAGE_LABELS.pack_sniper` entry + `SHEET_PAGES`, and add app/(collections)/[collection]/pack-sniper/page.tsx that renders PackSniperClient scoped to that collection. This matches the tab pattern exactly. Caveat: confirm pack-sniper has per-collection data before adding it to non-TS collections — if it's TS-only today, add the tab to Top Shot only (gate on `collection.pages`).
- **(Quick) Outbound tab:** add one custom tab in collection-tab-bar that links to the existing global /insights/pack-sniper. Less clean (breaks the pages.map uniformity) but ~10 minutes.
Revert: remove the page entry / route. Verify: the tab shows in the collection nav (desktop + mobile sheet) and routes correctly.

## Guardrails

- Commit directly to main, no branches/PRs. Commit via PowerShell git (Git Bash can silent-no-op); re-verify `git rev-list --count origin/main..HEAD` = 0.
- Vercel maxDuration cap 800s; curl unreliable in Git Bash (use Invoke-WebRequest); don't string-replace-patch on Windows (CRLF) — full-file writes.
- Claude Code's direct inspection wins over this doc — line numbers are approximate, adapt to the real file.

End state: slabs lose the collection name, sniper loses the NATIVE chip + blank thumbnails, mobile gets a reachable theme toggle, and pack sniper is a discoverable tab.
