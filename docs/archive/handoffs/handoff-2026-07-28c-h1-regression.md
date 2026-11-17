# Handoff — 2026-07-28 (round 3) · one live regression from item 7, and two "open" items that aren't

## Context

Verified round 2 in an authenticated browser. **Your item 7 work is clean on every route it was aimed at** — all collection tab routes serve exactly one `<h1>`, and you shipped the context-suffixed variant (`"NBA Top Shot — Overview"`) rather than a bare collection label, which is the better call I flagged as optional. `/nba-top-shot/play`, `/packs`, `/nba-top-shot/pack-sniper`, `/nba-top-shot/sniper`, `/`, `/insights`, `/insights/squeeze`, `/about` all read exactly 1.

**But two routes now serve two `h1`s in production, and the root cause is a bad measurement in my round-2 handoff.** Item 7's evidence table was built from anonymous `fetch()` calls, and I never checked whether the routes were auth-gated. They are. Everything below follows from that.

---

## ⚠ 9. `/analytics/loans` and `/analytics/sales` have TWO h1s — revert the sr-only additions

**Files:** `app/(analytics)/analytics/loans/page.tsx`, `app/(analytics)/analytics/sales/page.tsx`

Measured in an authenticated browser, hydrated DOM:

| route | h1 count | h1s |
|---|---|---|
| `/analytics/loans` | **2** | `sr-only` "Flowty Loan Analytics (Historical) — NFT-Coll…" + visible "Flowty Loan Analytics" |
| `/analytics/sales` | **2** | `sr-only` "Sales Analytics — On-chain Sales Across Flow…" + visible "Sales Analytics" |

Both pages **already had a visible `<h1>`**. The `sr-only` ones you added are duplicates.

**Why the measurement lied.** Both routes 302 to `/login` for an anonymous request. An anonymous `fetch(..., {redirect:'follow'})` returns HTTP 200 with `res.url` pointing at `/login`, so a naive `h1` count on the body measures **the login page**, which has none. The tell was there and I missed it: every one of these routes returned a body of **exactly 21,350 bytes** — the identical login page each time.

**Fix:** remove the `sr-only` `<h1>` from both. Keep the regression tests, but assert against an *authenticated* fetch or the hydrated DOM.

**This is the same failure mode you already caught once today** on `packs`/`play`/`pack-sniper` — deriving from a proxy instead of the real thing. It recurred because my handoff handed you the proxy as evidence. Any future h1 sweep on this codebase must record `res.url` and `res.redirected`, and treat a redirect to `/login` as "not measured" rather than "zero".

**Revert:** revert the two `sr-only` additions.

---

## 10. Close `fast-break` and `road-to-the-ring` — there is no third early return

You left these open, suspecting an unchased third early return. There isn't one.

`app/(collections)/[collection]/fast-break/page.tsx` has exactly **two** page-level returns, at lines 83 and 166, and both carry `<h1 style={PAGE_HEADER_STYLE}>Fast Break Optimizer</h1>` (lines 85 and 169). The returns at 198, 214 and 230 are **local helper components** defined below the page body — `SignInCard()`, `ConnectWalletCard()` and `NoRunCard()` — not branches of the page.

The h1=0 reading came from the same login-page artifact as item 9: `/nba-top-shot/fast-break` 302s anonymously. Authenticated, it redirects again — to `/nba-top-shot/overview`, which serves exactly one correct h1 (`"NBA Top Shot — Overview"`). So the route isn't rendering its own page at all in the current build, which is a separate product question (is Fast Break meant to be reachable?) and **not** a heading defect.

**No code change requested.** Just close both items and, if the redirect-to-overview is unintended, treat that as its own investigation.

---

## 11. `/analytics/pulse` — right conclusion, wrong reason (no action)

You correctly declined to "fix" it. The stated reason — a first-flush artifact of `PulseDashboard`'s single top-level return — isn't what's happening: the anonymous SSR body was byte-identical across two cache-busted runs, which rules out a flush race. It 302s to `/login` like its siblings. Authenticated, the hydrated DOM has exactly **one** visible h1, "Pulse — Live Flow NFT Activity". Genuinely fine.

Worth recording because the *reason* matters for the next sweep: three `(analytics)` routes and at least two collection sub-routes are auth-gated, so any anonymous audit of that group reports zeros that mean nothing.

---

## 12. The 40-minute build deserves a look before the next deploy

Not a code change — a watch item, but a sharp one. Your last build sat in static generation for ~40 minutes against 168s for the previous one, with `[health] rpc_error … statement timeout` at page 309/412, and **production served the double-h1 on three routes for that entire window**.

Two things follow. First, a build that takes 14× longer than its predecessor because a data call is timing out means static generation is doing live DB work with no timeout budget of its own — worth finding which page's `generateStaticParams`/fetch calls the health RPC and giving it an explicit short timeout with a safe fallback, so a slow DB degrades the *page* rather than the *deploy*. Second, and more operationally: a long static-generation window is exactly when a half-verified change is live and unnoticed. Verifying immediately after "deploy triggered" rather than after "deploy READY" is what let the double-h1 reach production.

Nothing to revert. Flagging so it is diagnosed while the log is still retrievable.

---

## Guardrails

Unchanged, plus the one earned here: **an anonymous fetch that follows redirects is not a measurement of the route you asked for.** Always record `res.url` / `res.redirected`; a body of ~21,350 bytes on this site is the login page.

**Claude Code's direct file inspection wins over this doc on any disagreement — adapt to the actual file shape.**

## Expected end state

`/analytics/loans` and `/analytics/sales` back to exactly one h1 each; `fast-break` and `road-to-the-ring` closed as non-defects; every other route unchanged at exactly one h1; the build-time health-RPC timeout diagnosed or explicitly accepted.
