# Handoff 2026-06-13 — Remove the QR code from trophy-case slab labels

Cosmetic UI change. Cowork can't push .tsx, so this is for Claude Code. One file. Verified the QR-on-slab lives in exactly one place.

## Context

The trophy-case slab label renders a 32px QR code (link to the moment page) in a fixed 40px left column. It's unnecessary and it squishes the middle text column (player name / collection / play description / set name all share the remaining width and clamp hard). Remove the QR and give that width back to the text. Keep the RPC pinwheel brand mark.

## File (verified it exists, grep-confirmed the only slab QR source)

components/TrophySlab.tsx — the `qrcode.react` QR is used ONLY here, inside the `SlabLabel` sub-component. Both owner and public trophy cases render through `FilledSlab` → `SlabLabel`, so this one change fixes both modes.

Do NOT remove the `qrcode.react` dependency from package.json — app/moment/[id]/page.tsx also imports it (separate "scan to view" QR, unrelated, leave it). Do NOT touch the moment-page QR.

## Change

1. Line ~5: remove `import { QRCodeSVG } from "qrcode.react";` (used only by SlabLabel in this file — confirm with a grep of the file before deleting).
2. Line ~187 (inside `FilledSlab`): remove `const qrUrl = "https://www.rippackscity.com/moment/" + slab.moment_id;`.
3. Line ~265: change `<SlabLabel slab={slab} qrUrl={qrUrl} accent={accent} />` to `<SlabLabel slab={slab} accent={accent} />`.
4. `SlabLabel` signature (~lines 331-339): drop the `qrUrl` param + its type.
5. `SlabLabel` left column (~lines 363-382): delete the `<QRCodeSVG ... />` element (lines ~374-380). Keep `<PinwheelMark size={14} color="#0a0a0a" />`. Reflow: change the left-column wrapper's `width: 40` to `width: 16` (just the pinwheel) — the middle text column is `flex: 1`, so it automatically reclaims the freed ~24px and the name/set lines stop clamping as hard. (If you'd rather, relocate the pinwheel — e.g., a small mark by the tier in the right column — and delete the left column entirely for max text width; your call on the cleanest look. The minimal width:40→16 change is the safe one.)

Leave everything else: the label `height: 84` + `overflow: hidden`, the badge-dots overlay (top:14/right:14), the middle/right columns. After the reflow, just eyeball that the badge dots still sit cleanly over the (now slightly wider) middle area.

## Verify

- `npx tsc --noEmit` clean (the removed `qrUrl` + import + prop leave no dangling refs).
- Deploy READY.
- Eyeball: owner view at /dashboard (trophy case section) and a public /profile/<username> with pinned slabs — slab labels show the pinwheel, no QR, and the player/set text has more room.

## Revert

`git revert <sha>`.

## Guardrails

- Commit directly to main. No branches, no PRs. If a claude/* branch is pre-checked-out, switch to main first.
- Commit via PowerShell git on Windows (Git Bash git commit can silently no-op). Re-verify push: `git rev-list --count origin/main..HEAD` (expect 0).
- curl fails silently in Git Bash for Vercel REST — use PowerShell Invoke-WebRequest.
- Don't string-replace-patch on Windows (CRLF) — full-file write or findIndex on split lines.
- Claude Code's direct file inspection wins over this doc on any disagreement — adapt to the actual line numbers (they're approximate).

End state: one commit on main, deploy READY, trophy-case slab labels show the pinwheel only and the text breathes.
