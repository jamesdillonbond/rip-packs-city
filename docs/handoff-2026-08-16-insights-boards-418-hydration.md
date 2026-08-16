# Handoff — `/insights/first-mint` (and `serial-premiums`) throw React #418 hydration error

**Date:** 2026-08-16 · **From:** Cowork weekly surface QA (`rpc-surface-qa`) · **For:** Claude Code on Trevor's machine

## Context

Cowork found this by live console-reading during the weekly QA sweep — the DB-side monitor and the night pass are structurally blind to hydration errors, so only a real browser catches this class (this is the same class as the systemic insights-board #418 from 2026-06-30). **Nothing here is shipped yet** — this is a `.tsx` change, which Cowork can't push (no git credentials). Two small client files; one-line fix each. No DB/migration/edge-fn involved. HEAD commit at time of writing unknown (deploy dpl chunk observed live: `dpl_GuT3UHpnzU5mP9TsFfWyGrXhm3va`).

## The finding

Loading **`/insights/first-mint`** throws, on every load where the data lines up:

```
Error: Minified React error #418; visit https://react.dev/errors/418?args[]=text&args[]=
```

`#418` with `args[]=text` is a **hydration text-content mismatch** — the server-rendered HTML text differs from what the client renders on hydration. **Live-confirmed:** reproduced deterministically on two clean reloads of `/insights/first-mint`. The other boards checked this run — `squeeze`, `deals`, `market`, `pack-sniper` — were clean.

### Root cause

Both boards render a **row date with `toLocaleDateString` and no `timeZone` option**, inside a `"use client"` board component whose table is **server-rendered first (for crawlability) then hydrated**. `toLocaleDateString` with no `timeZone` uses the *runtime* zone: the server renders in UTC (Vercel), the browser renders in the visitor's local zone. Any row whose sale/mint timestamp falls near a UTC-day boundary renders a different day server-side vs client-side (e.g. "Aug 16" server / "Aug 15" client) → React #418.

This is confirmed by the sibling boards that **do** pin a zone and are clean: `new-collectors/NewCollectorsBoardClient.tsx:77` uses `timeZone: "UTC"`; `market-pulse` and `parallel-premiums` use `timeZone: "America/New_York"`. The two boards below simply missed it.

## Item 1 — `first-mint` (LIVE-CONFIRMED)

**File:** `app/insights/first-mint/FirstMintBoardClient.tsx` (verified exists; `"use client"`)

- Helper `fmtDate` at **line 66-68**, rendered at **line 352** (`<td>{fmtDate(r.mint_one_sold_at)}</td>` — the "first mint sold" date column).
- Current line 68:
  ```ts
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" })
  ```
- Change to:
  ```ts
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })
  ```

## Item 2 — `serial-premiums` (CODE-CONFIRMED, latent)

**File:** `app/insights/serial-premiums/SerialPremiumsBoardClient.tsx` (verified exists; `"use client"`)

- Identical defect: helper `fmtDate` at **line 81-86**, rendered at **line 196 and line 238** (`{fmtDate(r.headline_sold_at)}` — desktop + mobile layouts of the "#1 last sold" date).
- This did **not** fire on the reload I tested — expected, because #418 here is data-and-time-dependent (fires only when a currently-top-ranked row's `headline_sold_at` straddles the UTC/local boundary). The code is the same bug and **will** fire; fix it in the same commit to close the class.
- Current line 85:
  ```ts
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
  ```
- Change to:
  ```ts
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" })
  ```

**Why UTC:** it matches `new-collectors` (the other row-date board) and the DB's UTC storage, so the displayed day is consistent for every visitor. Trade-off to know: a sale at `2026-08-16T02:00Z` (Aug 15 evening PT) will now render "Aug 16" for everyone instead of the viewer's local day — that is the intended, canonical behavior. If Trevor would rather these row dates read in ET (as the "Updated … ET" footers do via `America/New_York`), use that instead — either fixed zone eliminates the mismatch; the point is that **a fixed `timeZone` is required**.

## Verification expected

- `npx tsc --noEmit` clean.
- Vercel deploy reaches READY (aliased to www).
- **The real check is live console-reading, because CI can't see this class:** open `/insights/first-mint` in a browser, reload, and confirm **no `Minified React error #418`** in the console. (The `e2e-smoke` Playwright monitor asserts rendered DOM but does not read the console, so it will not catch a regression here — a source guard forbidding `toLocaleDateString`/`toLocaleTimeString` without a `timeZone` in `app/insights/**` + `components/insights/**` client components would be the durable backstop if you want one.)
- Optional: also reload `/insights/serial-premiums` a few times across a UTC-midnight-adjacent window to confirm it's clean.

## Guardrails (repeat every handoff)

- **Commit and push directly to `main`. No branches, no PRs** (CLAUDE.md non-negotiable). If a `claude/*` branch is pre-checked-out, `git switch main` first.
- **Commit via PowerShell `git` on Windows** — Git Bash `git commit` can silently no-op. Re-verify the push: `git rev-list --count origin/main..HEAD` should print `0`.
- `curl` fails silently in Git Bash for Vercel REST — use PowerShell `Invoke-WebRequest` if you redeploy by API.
- Vercel Pro `maxDuration` hard cap is **800s** — higher sends the deploy to ERROR invisibly (not relevant to this change, but standard).
- CRLF: don't string-replace-patch on Windows — use full-file writes (or `findIndex` on split lines). For these two one-line edits, a full-file rewrite of each client is the clean path.
- **Log to the ledger** (`docs/overnight/ledger.md`) after shipping: date · what shipped · revert path. Commit the ledger BEFORE the code so the code commit is the deploy-triggering tip.

## Revert path

Single commit touching both files → `git revert <sha>`. Or manually delete the `, timeZone: "UTC"` addition from `FirstMintBoardClient.tsx:68` and `SerialPremiumsBoardClient.tsx:85`. No DB or deploy-config state to unwind.

## Note

Claude Code's direct file inspection wins over this doc and over `project_knowledge_search` on any disagreement — adapt to the actual file shape (line numbers may have drifted; the helpers are named `fmtDate` in both files and are the only unguarded `toLocaleDateString` in `app/insights/**`).

**Expected end state:** one commit on `main`, deploy READY, `/insights/first-mint` (and `serial-premiums`) reload with zero `#418` in the browser console; ledger updated.
