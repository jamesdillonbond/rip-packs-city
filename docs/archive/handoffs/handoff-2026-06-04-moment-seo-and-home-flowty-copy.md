# Handoff — moment-page SEO (title + canonical) + stale Flowty home copy — 2026-06-04

Source: weekly rpc-surface-qa pass (Cowork). All three items are route/.tsx changes Cowork cannot push (no git creds), so they are packaged here for Claude Code. Nothing in this handoff is a production outage — these are SEO correctness + one stale marketing string. Live platform was otherwise green this pass (sitemap 31,125 URLs / 0 gated, edition + insights + moment pages render anon with correct robots/JSON-LD, best-offer + FMV cells live).

Context — already verified this pass (no action): edition page /nba-top-shot/edition/<slug> is self-canonical + index,follow + Product/BreadcrumbList/CollectionPage JSON-LD; /insights/squeeze self-canonical + index,follow + populates 200 rows fresh today; proxy.ts isPublicPath still opens singular entity segments + /moment/* + /insights/* to anon GET/HEAD. No DB migration involved.

Current HEAD: unknown to this pass — Claude Code: run git log -1 before starting.

---

ITEM 1 (P2) — Moment page document title is double-suffixed "| Rip Packs City | Rip Packs City"

File: app/moment/[id]/page.tsx (generateMetadata, around lines 385–403).

Symptom (observed live 2026-06-04 on /moment/6aa54124-ae30-47eb-b390-349ec545915b): document.title = "Bradley Beal (75 circulation) · Lace 'Em Up · LEGENDARY | Rip Packs City | Rip Packs City". The brand suffix appears twice. The edition page and /insights pages are correct (single suffix), so this is specific to the moment route.

Root cause: line ~385 builds the title string with the suffix already baked in —
  const title = `${player}${serialSuffix} · ${setName} · ${tier} | Rip Packs City`
— and line ~389 returns it as a plain string `title`. The root layout's metadata (defined in lib/seo.ts, the `%s | Rip Packs City` title.template applied site-wide) then appends "| Rip Packs City" a second time to any plain-string page title. Entity pages avoid this because they go through lib/seo.ts buildMeta, which does not hardcode the suffix.

Fix (minimal, one line, preserves the branded OG/Twitter title): on the returned metadata object change the title field from
  title,
to
  title: { absolute: title },
Using { absolute } tells Next to use the exact string for the document <title> and skip the template, so the document title becomes "…· LEGENDARY | Rip Packs City" (single). openGraph.title and twitter.title keep using the full `title` string (still brand-suffixed, which is what you want on social cards). Do not also drop the suffix from line 385 if you take the absolute approach, or OG/Twitter titles lose the brand text.

Alternative (equally valid): drop " | Rip Packs City" from the line ~385 template and leave `title,` as-is — the site template then adds the suffix once. This makes OG/Twitter titles brand-free; pick this only if you prefer that.

Verify: after deploy, view-source /moment/<id> → exactly one "| Rip Packs City" in <title>. npx tsc --noEmit clean.
Revert: git revert <sha>.

---

ITEM 2 (P2) — Moment page emits no <link rel=canonical>

File: app/moment/[id]/page.tsx (same generateMetadata return, lines ~388–403).

Symptom (observed live same page): document.querySelector('link[rel=canonical]') === null. The edition page sets a self-canonical; the moment page sets none — yet /moment/<id> is advertised in app/sitemap.ts (top-200 moments), so the canonical should be self-referential for crawlers.

Root cause: the moment route hand-rolls its Metadata (openGraph + twitter only) and never sets `alternates.canonical`. It does not import lib/seo.ts, so it misses buildMeta's canonical handling. metadataBase is already set (lib/seo.ts: metadataBase: new URL(BASE_URL)), so a relative canonical resolves to absolute automatically.

Fix: add an `alternates` field to the returned metadata object (alongside openGraph/twitter):
  alternates: { canonical: `/moment/${encodeURIComponent(id)}` },
`id` is already in scope (the route param). This yields <link rel="canonical" href="https://www.rippackscity.com/moment/<id>">. Apply it in the success-path return only (the not-found early return at line ~372 can stay as-is). Confirm the exact param-encoding matches how app/sitemap.ts writes the /moment URL (it uses the raw e.id uuid, no encode needed for a uuid, but encodeURIComponent is harmless on a uuid).

Verify: view-source /moment/<id> → one <link rel=canonical> equal to the page URL. npx tsc --noEmit clean.
Revert: git revert <sha> (folds with Item 1 if shipped in one commit).

---

ITEM 3 (P3) — Home marketing copy still names Flowty as a live listings source

File: components/HomePageMarketing.tsx (around line 273, in the HOW_STEPS array).

Symptom: the "how it works" copy reads "We pull live FMV from sales data, real listings from Top Shot and Flowty, badges, serials, and series labels." Flowty shut its NFT marketplace 2026-05-13 (CLAUDE.md Platform changes); the Market/Sniper surfaces were already reframed off Flowty (b19d8f2). The home page is the top of the anon funnel, so naming a dead marketplace as a current source is a small credibility nit.

Fix: drop "and Flowty" (or reword to "real listings from Top Shot"). Verify the exact current string first — Claude Code: grep the file, the wording may have shifted. No functional change, copy only.

Verify: npx tsc --noEmit clean; home (or /dashboard if logged in) renders.
Revert: git revert <sha>.

---

Guardrails (repeat every handoff):
- Work directly on main. No branches, no PRs (CLAUDE.md non-negotiable). If a claude/* branch is pre-checked-out, switch to main first.
- Commit via PowerShell git on Windows (Git Bash git commit can silently no-op). Re-verify the push with git rev-list --count origin/main..HEAD (expect 0).
- curl fails silently in Git Bash for Vercel REST — use PowerShell Invoke-WebRequest.
- Vercel Pro maxDuration hard cap is 800s — higher sends the deploy to ERROR invisibly.
- CRLF: don't string-replace-patch on Windows; use full-file writes or findIndex on split lines. These three edits are tiny and surgical, so a careful in-place edit is fine, but verify the file isn't CRLF-mangled after.
- Items 1+2 are the same file and the same function — ship them in one commit.

Claude Code's direct file inspection wins over this doc and over project_knowledge_search on any disagreement — the line numbers here are from a 2026-06-04 read and may have shifted; adapt to the actual file shape.

Expected end state: one commit on main touching app/moment/[id]/page.tsx (Items 1+2) and optionally components/HomePageMarketing.tsx (Item 3); Vercel deploy READY; view-source of any /moment/<id> shows a single "| Rip Packs City" title and one self-referential canonical link.
