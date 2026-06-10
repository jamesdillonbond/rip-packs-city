# Handoff 2026-06-10 — GSC indexing noise: stop advertising the 6,404 TS fossil editions

## Context

Cowork dug the GSC "new reasons preventing indexing" notices. Mapping (all verified against live data 2026-06-10):
- "Not found (404)" = Google recrawling edition URLs DELETED by the dedup merges (2026-05-26 + DUPE1 era). Self-healing as the crawler drops them; item (b) below accelerates it.
- "Duplicate, Google chose different canonical than user" = the 6,404 LIVE inert UUID-keyed TS fossil editions: app/sitemap.ts advertises every editions row (its only filter is !!external_id, verified L373), get_edition_detail RESOLVES fossils (verified: non-null for sample 208ae30a-...:1a78b1c1-...), so Google sees 6,404 thin near-duplicate pages — 19% of the ~33K sitemap wasted on junk crawl budget.
- "Page with redirect" = intentional (/pinnacle orphan redirect, apex->www, old flat routes). No action.
- "Alternate page with proper canonical tag" + "Blocked by robots.txt" = expected param-URL/private-surface classes. No action.

Format census (the trap that shapes the predicate): TS 15,542 = 9,136 canonical int-pair + 6,404 uuid-like fossils (+2 single-int oddities); AllDay 6,191 single-int canonical; Golazos 581 single-int canonical; **UFC 446 — ALL uuid-like, that IS its canonical format.** Any hyphen-based exclusion must therefore be scoped to nba_top_shot ONLY.

Claude Code's direct file inspection wins over this doc on any disagreement.

## Item (a) — sitemap filter (the core fix, one predicate)

app/sitemap.ts, the edition-entry build (~L371-378, currently .filter((e) => !!e.external_id)): additionally exclude rows where the row's collection is NBA Top Shot AND external_id contains a hyphen. The rows already carry collection_id (selected at ~L150), and the TS UUID is in lib (TOPSHOT 95f28a17-224a-4025-96ad-adf8a4c63bfd). Do NOT apply the hyphen test to any other collection (UFC's canonical ids are uuid-like). Expected: sitemap edition entries drop ~23.5K -> ~17.1K; set/player/team slug derivation also stops seeing fossil rows (verify those derive from the same filtered array — if they derive pre-filter, filter at the source array instead).

## Item (b) — recommended: 404 the fossil edition pages

app/(collections)/[collection]/edition/[slug]/page.tsx: before the get_edition_detail call, if the resolved collection is NBA Top Shot and the decoded slug contains a hyphen (uuid-format), notFound(). Zero canonical content lost (canonical TS pages are int:int; fossils have NULL on-chain ids, no thumbnail, no FMV) and it converts Google's "duplicate" cluster into clean 404s it drops quickly — same class as the grids already excluding fossils via the thumbnail filter (May-31 entity RPCs). If you'd rather keep fossils reachable, skip (b) and ship (a) alone — (a) is the load-bearing fix.

## Verification

npx tsc --noEmit clean; deploy READY; live /sitemap.xml edition count drops ~6.4K; spot-check a fossil URL (e.g. /nba-top-shot/edition/208ae30a-a4fe-42d4-9e51-e6fd1ad2a7a9%3A1a78b1c1-ed71-46d8-80d0-58e3bd509b22) -> 404 with (b), absent from sitemap either way; a canonical int-pair URL (e.g. /nba-top-shot/edition/2%3A188) still 200 + in sitemap; UFC edition URLs still present in sitemap (the scoping check). Smoke green.

## Revert

git revert the commit. GSC effects lag by crawl cycles either way.

## Guardrails (repeat every handoff)

- Direct-to-main, no branches, no PRs. PowerShell git; verify push with git rev-list --count origin/main..HEAD (expect 0).
- curl fails silently in Git Bash for Vercel REST — PowerShell Invoke-WebRequest.
- maxDuration cap 800s. CRLF: full-file writes or findIndex on split lines.
- Run the smoke test after deploy.

## End state

One small commit: the sitemap advertises only canonical editions (~17.1K of real pages), fossil URLs 404 (if (b)), UFC untouched, and the GSC duplicate/404 noise drains over the following crawl cycles. The remaining GSC reasons are documented-intentional.
