---
name: rpc-surface-qa
description: >-
  Run the weekly Rip Packs City user-facing surface QA — the full sweep across
  live pages, insights boards, pack/moment/edition detail surfaces, the Pack
  Sniper, the live Cowork dashboard artifacts, the fabricated-data/brand repo
  greps, and SEO. Use this whenever the user asks to "run the surface QA",
  "do the weekly RPC QA", "QA the live pages/site", "check the insights boards
  / pack sniper / moment pages", "audit the artifacts", or when the scheduled
  rpc-surface-qa task fires with no other instruction — even if they don't say
  the words "surface QA". It encodes the discipline (report is the default
  output; never touch route/.tsx/worker code — hand those off; artifacts +
  additive docs are the only things you may ship), the exact per-surface
  checklist, the browser-automation gotchas that make this pass reliable, and
  the known false-positives so you don't re-chase them.
---

# Rip Packs City — weekly user-facing surface QA

This is a **verification** pass over the live product (https://www.rippackscity.com), its
live Cowork dashboard artifacts, and the repo. A clean week is a good report — the job is to
**find regressions and report them honestly**, not to manufacture findings or ship risky changes.

Read `CLAUDE.md` in the connected repo (`C:\Users\TDill\rip-packs-city`) for platform context
before you start; it carries the honesty canon ("a failed read must not render as an answer"),
the brand tokens, and the two-collection-vocabulary footguns this QA leans on.

## What you may and may not do (the discipline)

- **The default output is a report (the digest).** When in doubt, report — don't act.
- **You MAY** refresh a genuinely stale live artifact (`update_artifact`) and ship **additive
  doc fixes** into the repo.
- **You MUST NOT** change route code, `.tsx`, or `workers/*` — not because Cowork cannot push (it often can: see `docs/reference/tooling-gotchas.md`) but because this pass cannot run the render/test loop that change needs
  path and those are the highest-risk surfaces. Package any needed code fix as a **Claude-Code
  handoff** in `docs/` of the connected repo, using the `rpc-handoff` skill (normal markdown,
  read on desktop, with a per-item revert path). Verify file paths exist before naming them.
- Respect anything in `docs/overnight/ledger.md` marked "Declined — do not re-suggest", and skim
  the recent ledger so a handoff doesn't collide with queued/declined work.

## The pass, in four parts

Work the four parts in whatever order is efficient; the repo greps (Part 3) are local and fast,
the browser work (Parts 2 & 4) is the bulk. **The exhaustive, current per-surface checklist —
every artifact id, every specific URL and what it must show, every grep pattern and SEO check —
lives in `references/surface-checklist.md`. Read it before starting; it is the source of truth
for *what* to check.** This body is the *how* and *why*.

1. **Artifact freshness + brand.** Read each live Cowork dashboard artifact that exists (many
   listed ids have been retired — only some exist; `list_artifacts` gives the truth). For each:
   confirm embedded queries reference **current** DB objects (verify object existence against the
   live DB in one query rather than eyeballing), flag hardcoded prose numbers/statuses that have
   drifted, and check brand (RPC red accent, uppercase letter-spaced headers, monospace numbers;
   Chart.js/canvas hex literals are the allowed exception). **Only refresh an artifact with a
   *genuine* inaccuracy, and never burn a risky full-file reinstall on cosmetic display-only prose
   alone** — the checklist names the known-deferred prose items; report them, don't rebuild for them.

2. **Live pages (Claude in Chrome).** Load the home page, a `/moment/<id>`, a
   `/<collection>/edition/<slug>`, an `/insights` board, the dated pack/edition detail surfaces,
   a Pinnacle per-render page, and the Pack Sniper (page render + both API feed legs as JSON +
   served-HTML crawlability + outbound-click total). **Console-error-check EVERY page** after it
   settles (hydration #418/#423, uncaught exceptions, and repeated 4xx/5xx telemetry beacons —
   the DB monitor is blind to all of these). Check desktop and mobile width. Flag regressions;
   handoff any code fix.

3. **Fabricated-data + brand greps (repo).** Grep live user-facing routes for `Math.random` /
   `stub` / `mock` / `fake` rendered to real users, and `app/`+`components/` for hardcoded
   `#E03A2F` / `Barlow Condensed` in style props with no `var()` fallback. The checklist lists the
   allowed exceptions (retry jitter, session ids, React-key fallbacks, the labelled pack
   *simulator*, email bodies, recharts strokes, `accent_color` data, `theme-color` meta, console
   art, annotated `brand-exception` literals) — flag only NEW violations.

4. **SEO sample.** Confirm the sitemap emits ~33K URLs; spot-check entity/insights pages for
   self-canonical + JSON-LD + `index,follow`; verify the Pack Sniper is linked from the hub +
   footer and its OG returns a non-trivial `image/png`; for any board claiming crawlability, verify
   the **served HTML** (raw fetch, not the hydrated DOM) actually contains the drill-down markers.

## Browser-automation technique (this is what makes the pass reliable)

The Claude-in-Chrome tools have sharp edges that will silently give you wrong answers if you don't
respect them. **Read `references/browser-qa-and-known-issues.md` before the browser work** — it has
the full recipes. The load-bearing ones:

- **Console + network tracking start on the *first* call per tab** and only capture from *then*.
  So `read_console_messages`/`read_network_requests` right after a fresh load returns nothing useful.
  The pattern: read once to arm tracking, then `navigate` (same-domain nav keeps tracking) and read
  again after the page settles — or reload once and read.
- **`javascript_tool` refuses to return values containing query-string/cookie-like data** ("BLOCKED:
  Cookie/query string data"). Build marker substrings dynamically (`"pack"+"Detail"+"="`) and return
  **booleans/counts, not raw URLs**, when you need to assert on a link's shape.
- **Served-HTML crawlability** ≠ hydrated DOM. Fetch the raw body (`fetch(path,{headers:{accept:"text/html"}})`)
  and count markers with `html.split(marker).length-1`; the DOM can show rows the served HTML lacks.
- **`resize_window` bottoms out at ~738px** in Cowork — true sub-420 needs a real browser (Playwright).
  Report that caveat rather than claiming a sub-420 result.
- Prefer `get_page_text` / a targeted `querySelectorAll` over screenshots; some sections render into
  `display:none`/hidden subtrees, so check `offsetHeight>0` when you need to know a thing is *visible*,
  not merely present.

## Known false-positives — do NOT re-file or re-chase these

`references/browser-qa-and-known-issues.md` keeps the running list. The big one as of 2026-08-27:
in **Cowork's own logged-in browser**, `/moment/<id>` and `/<collection>/edition/<slug>` (the routes
with the "SCANNING THE MARKETPLACE…" route-level `LoadingState` fallback) can hang on the client
reveal — content is correctly SSR'd but stuck in a `display:none` subtree, no console error. This was
run to ground: it is **independent of login/owner-key/preloader, badge-art budget, and page structure**,
reproduces on **no** normal-browser axis, and is almost certainly a Cowork-browser streaming-reveal
artifact, **not a shippable defect**. If you see it, note it and move on — verify the same URL in a
normal browser before ever escalating.

## Output contract — the digest

Close every run with a digest in this shape (prose, tight — the reader has not been watching):

```
Status: <clean, or the headline finding>
Artifacts: <each read; each refreshed + the fix, or "none refreshed" + why>
Live pages + mobile: <per-surface results; the pack/moment/edition history surfaces; the Pack
                      Sniper checks incl. its outbound-click running total; console findings>
Fabricated-data / brand greps: <NEW violations, or clean>
SEO: <sitemap count; canonical/JSON-LD/robots; pack-sniper OG + links; served-HTML crawlability>
Handoffs: <files written to docs/, or none>
```

If you shipped anything to `main`/prod (rare — artifacts and docs only), append a ledger entry per
`CLAUDE.md`. A pure report/no-op run writes no ledger entry.
