# Handoff — footer tagline scrub + mobile polish (Claude Code)

Plain-text, paste-into-Claude-Code. Three small, independent changes. Work on main, commit + push, tsc + smoke after. Each has a revert.

Context: real-phone mobile QA on 2026-06-01 found (a) the footer "Built for Collectors, By Collectors" tagline — that's **Flowty's** line, scrub it; (b) the footer 3-col grid cramps <640px (PRIVACY clips); (c) the /insights/deals board flashes "0 / LOADING…" KPIs for ~5–7s before data lands. (a) and (b) are the same file and combine cleanly.

---

M1+M3 — FOOTER: remove the Flowty tagline AND fix mobile cramping (one change).
File: components/SiteFooter.tsx + app/rpc-tokens.css.

The footer top is a hardcoded 3-col grid (gridTemplateColumns: "1fr auto 1fr") with the center column being the "BUILT FOR COLLECTORS, BY COLLECTORS" tagline (lines ~43-55). Removing the tagline turns it into a clean 2-col (brand | social), which also stops the mobile cramp.

Do:
1. Delete the entire center "Community tagline" <span> block (lines ~43-55, the one rendering "BUILT FOR COLLECTORS, BY COLLECTORS").
2. Change the top grid from inline gridTemplateColumns: "1fr auto 1fr" to a responsive 2-col. Inline styles can't do @media, so move the layout to a class. In app/rpc-tokens.css add:
   .rpc-footer-top { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: 24px; }
   .rpc-footer-bottom { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
   @media (max-width: 640px) {
     .rpc-footer-top { grid-template-columns: 1fr; justify-items: center; text-align: center; gap: 12px; }
     .rpc-footer-bottom { flex-direction: column; align-items: center; gap: 8px; }
     .rpc-footer-bottom > div { justify-content: center; }
   }
   Then on the footer top container (the div at ~line 15) replace the inline display/grid/align/gap props with className="rpc-footer-top" (keep maxWidth/margin/padding inline). On the bottom strip container (the flex div at ~line 89) add className="rpc-footer-bottom" and drop its inline display/justify so the class wins. This stacks the copyright above the links and centers them on mobile, so "PRIVACY" stops clipping.
3. The "BUILT ON FLOW" badge + @RIPPACKSCITY (right column) and "COLLECTOR INTELLIGENCE PLATFORM" (left) stay. The bottom "Built in Rip City for the Flow collectibles community." line stays — it's original and on-brand. Net: the Flowty tagline is gone and the real positioning (Collector Intelligence Platform) carries it.
Verify: footer shows no "Built for Collectors, By Collectors"; on a <640px viewport the footer stacks to one centered column and no link clips.
Revert: git revert.

M3b — SCRUB the tagline's other instances.
- app/(collections)/[collection]/overview/page.tsx:62 — section title is the VERBATIM "Built for Collectors, By Collectors". Replace with an original title. Suggested: "Collector-grade intelligence" (or "Pro analytics for serious collectors" — your pick). Must change; it's the exact Flowty line.
- app/(collections)/[collection]/overview/page.tsx:85 — body has the paraphrase "...Built for collectors who treat the game like collectors treat the hobby." Optional reword (softer echo) — e.g. "...so you catch mispriced moments the moment they list." and drop the trailing clause. Trevor's call.
- public/llms.txt:4 — has the reversed "Built by collectors, for collectors". Optional reword to avoid the borrowed phrase, e.g. "Built to bring pro-grade analytics to anyone ripping packs and tracking moments on Flow."
Verify: repo-wide grep for "by Collectors" / "Built for Collectors" returns only intended/reworded copy.
Revert: git revert.

M2 — /insights/deals (and sibling boards): kill the "0 / LOADING…" flash.
File: app/insights/deals/page.tsx (state at lines ~101-104: rows=[], loading=true).
Cause: the KPI cards (DEALS, ≥25% OFF, MEDIAN DISCOUNT, ROWS SHOWN) are computed from the empty rows array while loading is still true, so they render literal 0 / 0% for ~5–7s — reads like "no deals found" — before the fetch resolves. The table already has a loading branch (~line 301).
Fix: while loading is true, render the KPI values as a skeleton or an em-dash "—" instead of the computed-from-empty zeros (gate the KPI value render on !loading). Keep the existing LOADING panel for the table, or swap it for a few skeleton rows. Don't show a real number until data is in.
Apply the same gate to the sibling public boards that share this pattern (KPI cards over a client fetch): app/insights/offer-spread/page.tsx, app/insights/squeeze/page.tsx, app/insights/rookies/page.tsx, app/insights/market/page.tsx, app/insights/pack-reality/page.tsx — check each; fix any that flash 0s.
Verify: load /insights/deals on a throttled connection — KPIs show "—"/skeleton, never a "0 deals" flash, then fill in.
Revert: git revert.

---
Order/independence: all three are independent; M1+M3 are one file pair, M3b is copy, M2 is the insights boards. None touches DB, auth, pricing, or ingest. Low risk.
