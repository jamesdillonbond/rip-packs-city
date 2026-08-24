# Handoff — Candy `/insights/candy-mlb` rendered-page QA (polish items)

**Date:** 2026-07-24 · **Author:** Cowork (browser QA via Trevor's authed session) · **For:** Claude Code

**Headline: the page is go-live-ready.** It renders fully past the auth gate, on-brand (RPC red / condensed display / mono), with an excellent honesty disclosure (LOW-confidence, "—" cold tail, best-offer/ask ≠ FMV, Drop 3 caveat) and the troll-exclusion footnote. **Market tab** (125-edition table, troll-guarded floors) and **Holders tab** (246 collector wallets, treasury excluded, sane est. values) both verified rendering real data live. Badge counts all correct (Deals 21 / Spread 99 / Holders 246). The items below are **polish, not blockers** — all route/`.tsx`/copy.

## P1 — First-load empty-state race (Holders, likely any async tab)

On the very first render, the **Holders tab briefly showed "No holders" with badge `0`** before the data arrived; on any subsequent read it's the full 246. So the async tab data loads after first paint and the interim shows the *empty* state rather than a *loading* state. **Fix:** show a "Loading…" skeleton/state while the tab's fetch is in flight; only show "No holders" once the fetch resolves empty. Low severity but it's the first thing a fast-clicking user could see.

## P2 — Banner copy overstates LOW confidence

The disclosure says *"every price is **LOW-confidence** off 1–2 sales."* But editions with more trades now carry **MEDIUM** (Andy Pages 5 sales, Jacob Misiorowski 7, Logan Webb 5). Soften to *"most prices are LOW-confidence"* (or "LOW/MEDIUM confidence") so the banner doesn't contradict the MEDIUM tags in the table.

## P3 — "Last sale" can show a special-serial outlier vs edition FMV

Bryce Eldridge renders **last sale $77.82 vs FMV $4.22** — which *looks* broken but FMV is actually correct: its three sales are $77.82 (serial **#1**, first-mint premium), $3.49, $4.95, so edition FMV ≈ $4 and the engine rightly ignores the #1. The display just juxtaposes the raw most-recent sale (a #1) against edition-typical FMV. Only ~1 edition today, but it recurs whenever a #1/low serial is the latest sale. **Options:** annotate the last-sale cell with its serial (e.g. "$77.82 (#1)"), or exclude special-serial sales from the "last sale" column. Low priority; FMV itself is right.

## P4 — "BUILT ON FLOW" footer on a Solana page

The global footer reads **"BUILT ON FLOW"** and *"Built in Rip City for the Flow collectibles community,"* and the COLLECTIONS list is Flow-only — fine while Candy is gated, but on a **Solana** collection page it's a slight inconsistency to resolve at go-live (collection-aware footer, or "Built on Flow & Solana"). Tie this to the go-live flip, not now.

## P5 — K=10 leaves a few high floor asks (already a known tunable)

Visible on the page: Munetaka Murakami-PINK floor **$296** (FMV $85, ~3.5×), Bryce Eldridge floor **$31** (FMV $4, ~7×) — asks between 3× and <10× FMV pass the K=10 troll ceiling and show as the floor. This is the deferred `K` tunable from the troll-guard ship; tighten to K=5 if you want floors closer to FMV. Brand/UX call.

## Not cleanly verified (browser automation was flaky this session)

- **Console errors:** couldn't capture a clean console read (CDP screenshot timeouts + console tracking started post-load). The page renders with no visible errors, but the rendered timestamp ("Jul 24, 2026, 6:45 PM") is the classic `timeStyle` hydration-error vector (React #418) — worth a quick DevTools console check on your end.
- **Deals / Spread / Serials / Scarcity / Players tab bodies:** badge counts are correct and backing views are DB-clean, and Market + Holders both render, so confidence is high — but I didn't individually eyeball each of those 5 bodies (tab-switch clicks were flaky). A 2-minute manual click-through, or a retry, would close it.

## Guardrails

Copy/`.tsx` changes — direct to `main`, PowerShell git, `tsc` clean + Vercel READY. None of these gate go-live except at your discretion.
