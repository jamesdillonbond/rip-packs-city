# Handoff — Fix /share OG image (0-byte PNG on every wallet)

## Context

- Surfaced 2026-06-04 during the Dumbo VIP wallet warm. NOT a data problem and NOT Dumbo-specific.
- `app/share/[wallet]/opengraph-image.tsx` returns HTTP 200 `image/png` with 0 bytes for EVERY wallet — verified on 0x37a7e864611c7a85 (Dumbo) and 0xbd94cade097e50ac (Trevor's), 3 requests each. Meanwhile `/api/og/default` returns a real 131 KB 1200x630 PNG via the same client, so @vercel/og + the OG infrastructure are fine.
- Effect: every shared /share/<wallet> link unfurls a BLANK preview card in Slack / iMessage / Discord / Twitter — directly hurts the wallet-paste share funnel. The /share PAGE itself renders correctly; only the unfurl image is broken.
- No code shipped by Cowork for this — it is route code, handed to you. No DB/migration involved.

## The fix (primary)

File: app/share/[wallet]/opengraph-image.tsx

- Line 3: change  export const runtime = "edge"  to  export const runtime = "nodejs".
- That is the whole primary change. The route's JSX + its try/catch fetch to /api/collection-snapshot are structurally correct; the failure is the edge-runtime ImageResponse emitting an empty body. opengraph-image routes render ImageResponse reliably on the Node runtime, and /api/og/default (which works) is not pinned to edge.
- Keep everything else identical (the fetch, the size export, the JSX card).

## If nodejs alone does not fix it (fallback diagnosis)

- Wrap the  new ImageResponse(...)  return in try/catch and console.log the caught error plus whether the fetch resolved (totalFmv / totalMoments), then check Vercel runtime logs for /share/[wallet]/opengraph-image (production, short window, console.log not console.warn — warn is not indexed). The route logs nothing today, so a silent throw is invisible.
- Confirm the in-route fetch resolves server-side: siteUrl() is https://www.rippackscity.com in prod and GET /api/collection-snapshot is allow-listed in proxy.ts, so it returns 200. If it ever 307'd, the card would still render with $0 — NOT 0 bytes — so an empty body points at ImageResponse, not the fetch.
- Do NOT add a custom font fetch unless the logs show a font error — the default font path works on nodejs.

## Verify

- npx tsc --noEmit clean.
- After the deploy reaches READY, from PowerShell (curl fails silently in Git Bash):
  $r = Invoke-WebRequest -Uri "https://www.rippackscity.com/share/0x37a7e864611c7a85/opengraph-image"; $r.Headers["Content-Type"]; $r.RawContentLength
  Expect content-type image/png and RawContentLength in the tens of thousands (the working /api/og/default is ~131 KB). 0 = still broken.
- Eyeball it: open that OG URL in a browser — it should show the dark RPC card with "$9,002.87 / 825 moments" and Dumbo's top 3 players.
- Optional: paste a /share/<wallet> link into the Slack or Twitter card validator and confirm the preview now renders.

## Guardrails

- Direct to main, no branch, no PR (CLAUDE.md non-negotiable). If a claude/* branch is pre-checked-out, switch to main first.
- Commit via PowerShell git on Windows (Git Bash git commit can silently no-op). Re-verify the push with git rev-list --count origin/main..HEAD (expect 0).
- Vercel Pro maxDuration hard cap is 800s — not relevant here, just don't raise it.
- Your direct inspection wins over this doc on any disagreement — if the real cause turns out to be something other than the runtime, adapt to what you find.

## Revert

- git revert <commit> (it is a single one-line change), or set  export const runtime = "edge"  back.

## End state

- One-line commit on main, deploy READY, npx tsc --noEmit clean, and /share/<wallet>/opengraph-image returns a real ~tens-of-KB PNG for every wallet → shared /share links unfurl a branded RPC card instead of a blank box.
