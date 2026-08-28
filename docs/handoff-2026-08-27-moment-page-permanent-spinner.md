# Handoff — `/moment/<id>` renders a permanent "SCANNING THE MARKETPLACE…" spinner for JS visitors

**Date:** 2026-08-27 (weekly `rpc-surface-qa` pass)
**HEAD at time of writing:** `b29e7aba`
**Author:** Cowork (surface-QA). Route/`.tsx` change — Cowork has no git creds, so this is for Claude Code.

---

## Context

- Cowork shipped **nothing** for this item (it is route code). No migration, no edge fn, no data mutation this pass.
- This is the recurrence the prior investigation predicted. The ledger (2026-08) already carries this symptom: a session hardened the **layout gate** `lib/moment/resolve-moment-id.ts` (added a degraded-budget bound + a hang test) and explicitly wrote: *"if `rendered only 25 chars` comes back on a moment URL, start at `app/moment/[id]/page.tsx`'s own hydration, not the layout gate."* It has come back.
- **SSR is healthy — this is a client-reveal hang, not a server timeout or a 404.** Do not touch the layout gate again; it is doing its job.

## What I observed (measured, reproducible)

Loaded in the connected Chrome (logged-in session, a Flow/web3 wallet extension is injecting `pageProvider.js`/`script.js` — noted as a caveat below):

- `/moment/<id>` shows only **"SCANNING THE MARKETPLACE…"** (the route `loading.tsx` fallback) and never reveals content. Reproduced on **3 distinct moments**, still hung at **133 s** on the last one:
  - `/moment/980dbf7e-8440-4c45-a0a8-fadd6c110364` (WNBA)
  - `/moment/18e36e08-6622-48ef-955d-450319273b9c` (WNBA)
  - `/moment/502392c5-2b00-49e1-a47e-cf8ff28fa3bf` (Mikal Bridges — 2021 NBA Finals, LEGENDARY)
- `document.body.innerText` = **25 chars** ("SCANNING THE MARKETPLACE…") — the exact "25 chars" signature from the prior ledger note.
- **The real content IS in the DOM but hidden.** "Current FMV" resolves in the DOM with `offsetHeight === 0`; walking its ancestors, the whole content subtree sits inside a `display:none` wrapper while the spinner element is the only visible node.
- **The server render is complete and correct.** A raw `fetch('/moment/502392…', {accept:text/html})` (x-vercel-cache MISS, 200, 125 KB) contains the full visible content: `… Mikal Bridges Series 2 · Rim · Jul 9, 2021 Current FMV $122.00 Avg Sales Price $122.00 Top Shot ask $199.99 Best offer $55.00 · today …`. So crawlers and link-unfurlers get the data; only the hydrated client hangs.
- **No console error.** `read_console_messages(onlyErrors)` returns nothing — no React #418/#423, no uncaught exception. One non-fatal Recharts warning (`width(-1) height(-1)`), consistent with a chart mounting inside the zero-size hidden subtree. This is why the DB monitor + night pass are blind to it — it is a silent client hang.
- **Differential vs the sibling route that works:** `/nba-top-shot/edition/124:4493` renders its content fine in the same browser. That route was refactored **2026-06-23** to a Suspense fast-shell (see below); `/moment/[id]` was not.

### Root cause (hypothesis, strong)

`app/moment/[id]/layout.tsx` wraps the page in an implicit `<Suspense>` whose fallback is `loading.tsx` → `LoadingState` ("SCANNING THE MARKETPLACE…"). `app/moment/[id]/page.tsx` is one big `async` server component that, before returning **any** JSX, awaits:

1. `fetchMomentDetail(id)`, then
2. a `Promise.all([...])` of **8** SECDEF RPC reads (`fetchHighOffer`, `fetchParallels`, `fetchBadges`, `fetchSpecialSerialsForSerial`, `fetchMomentBestOffer`, `fetchEditionNotableSerials`, `fetchActiveListingAsk`, `fetchSubeditionSiblings`), then
3. `resolveUsernames(...)`, then
4. `fetchBadgeArt(...)`.

So the single Suspense boundary covers the **entire** fan-out. The sibling edition route already solved this — `app/(collections)/[collection]/edition/[slug]/page.tsx` around lines 424–435 reads:

> *"Fast shell — only the cheap single-row / aggregate RPCs the hero + FMV strip need. The heavy bottom sections … stream in below via `<Suspense>` … The route loading.tsx ('SCANNING THE MARKETPLACE…') now only covers this shell. (2026-06-23 — decouple FMV display from the slower market fetches.)"*

`/moment/[id]` never got that treatment, so the reveal is gated on the whole fan-out completing **and** the client swap firing. The prior session's own pointer was "start at page.tsx's own hydration" — that is exactly here.

## The fix (suggested — Claude Code owns the final shape)

Apply the edition route's **fast-shell + streamed-tail** pattern to `app/moment/[id]/page.tsx`:

- Keep only the cheap reads needed for the hero + FMV card (`fetchMomentDetail` and whatever the headline needs) in the top-level server component so the loading fallback covers only a lightweight shell.
- Move the heavy fan-out (the 8-RPC `Promise.all`, `resolveUsernames`, `fetchBadgeArt`, Special Serials, Recent Activity, Parallels) into a child `<Suspense>` that streams **below** the hero, each with its own bounded fallback — so a slow/never-settling market read can never hold the whole page behind the "SCANNING…" fallback.
- Keep every per-member `.catch()`/degraded-status discipline already in the file (the `summarizeDegraded`/`DegradedDataNotice` path). Note the edition route's ⚠ comment that its fast-shell block runs fetches with **zero** per-member `.catch()` and any throw takes the page to Next's unbranded 500 on an ISR route — carry a `.catch()` on each shell read here too.
- **Reproduce first in a clean browser profile (no wallet extension) before and after** — see caveat.

Files (all verified to exist at `b29e7aba`):

- `app/moment/[id]/page.tsx` — the change.
- `app/moment/[id]/layout.tsx` — the Suspense wrapper (context only; the comment at the top documents the implicit-Suspense behaviour).
- `app/moment/[id]/loading.tsx` / `components/ui/LoadingState.tsx` — the "SCANNING THE MARKETPLACE…" fallback (context; likely unchanged).
- Reference implementation: `app/(collections)/[collection]/edition/[slug]/page.tsx` (~lines 424–435 and the streamed `<Suspense>` block below).
- Do **not** touch `lib/moment/resolve-moment-id.ts` (layout gate; already hardened and hang-tested).

### ⚠ Caveat to resolve before/while fixing

The observation was made in the connected Chrome, which is **logged in** and has a **web3 wallet extension injecting scripts** into the page. Injected provider scripts can perturb hydration. I could not test a clean anon profile from here. **Step 1 for Claude Code: reproduce in a fresh profile (incognito, extensions off).** If it does NOT repro there, the finding narrows to "wallet-extension-injected pages break the moment-page reveal" — still worth the fast-shell fix (it bounds the reveal regardless), but reprioritise. If it DOES repro clean, it is a straightforward user-facing regression on the platform's most-shared URL and should ship.

### Verified facts / how

- 3 URLs, `body.innerText.length === 25` after 3–133 s waits — Chrome MCP `javascript_tool`.
- Content-in-DOM-but-`display:none` — `TreeWalker` for "Current FMV" + `getComputedStyle` ancestor walk.
- Server HTML complete — raw same-origin `fetch()` of the pathname, visible-text extraction.
- No console error — `read_console_messages({onlyErrors:true})` empty on all three.

### Revert path

New code only; revert = `git revert <the fix commit>` (find by message, not a pre-recorded sha). No DB/migration/cron/auth/hot-wallet/pricing surface touched.

### Expected verification

- `npx tsc --noEmit` clean (run `npm ci` first in a fresh sandbox).
- Full `npm test` green (the prior session added a moment-page hang test — keep it green; add one asserting the hero paints without the full fan-out if practical).
- Vercel deploy reaches **READY** for the fix commit.
- Manual: `/moment/<id>` in a clean profile paints the FMV hero within ~1 RPC and never sits on "SCANNING THE MARKETPLACE…".

---

## Secondary (low priority) — home page still missing `og:url`

`/` now emits a self-canonical (`<link rel="canonical" href="https://www.rippackscity.com"/>`) — the 2026-08-23 P2 Finding B canonical gap has **partially** closed. But the home page still has **no `og:url`** meta (every other page checked — `/insights`, `/insights/squeeze`, `/nba-top-shot/edition/124:4493` — has one). Add `openGraph.url` to the home route's metadata (root `app/layout.tsx` / the home `page.tsx` metadata, wherever the home `openGraph` is set). Cosmetic-SEO; bundle with any other metadata work.

---

## Guardrails (repeat every handoff)

- Commit **directly to `main`** — no branches, no PRs (CLAUDE.md non-negotiable). If a `claude/*` branch is pre-checked-out, `git switch main` first.
- Commit via **PowerShell `git`** on Windows (Git Bash `git commit` can silently no-op on backticks/CRLF). Re-verify the push: `git rev-list --count origin/main..HEAD` → expect `0`.
- **Commit the ledger entry BEFORE the code commit** so the code commit is the deploy-triggering tip (a docs-only tip suppresses the Vercel deploy).
- `curl` fails silently in Git Bash for Vercel REST — use PowerShell `Invoke-WebRequest`.
- Vercel Pro `maxDuration` hard cap is **800 s** — higher sends the deploy to ERROR invisibly.
- CRLF: no string-replace patches on Windows; full-file writes or `findIndex` on split lines.
- **Claude Code's direct file inspection wins over this doc and over `project_knowledge_search` on any disagreement — adapt to the actual file shape.**

## Expected end state

One commit on `main`, Vercel deploy READY, and `/moment/<id>` paints its FMV hero in a clean browser profile instead of hanging on "SCANNING THE MARKETPLACE…" — closing the recurrence the prior session flagged at `app/moment/[id]/page.tsx`.
