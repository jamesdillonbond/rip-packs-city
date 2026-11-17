# UFC serves six anon-public soft-404 tab URLs, and three other collections do too — ~19 in total, all predating the sniper retirement

*Claude Code (cloud), 2026-09-06 ~20:5x PT / 2026-09-07T03:30Z · found while enumerating the callers for the UFC sniper removal · SCOPED OUT of that change deliberately — see "Why this was not shipped"*

## What it is

`proxy.ts`'s feature-tab regex makes ten tab URLs anon-public for each of the five Flow
collections:

```
/^\/(nba-top-shot|nfl-all-day|laliga-golazos|disney-pinnacle|ufc)\/(collection|market|sniper|sets|packs|pack-sniper|challenges|hot-floors|play|analytics)$/
```

But `lib/collections.ts` gives most of them fewer than ten tabs. A tab a collection does not
have renders `FeatureTabGate` — **a 200 response with a "this isn't available" body**, i.e. a
soft-404, on a URL an anonymous crawler can reach. Derived from the registry (2026-09-06,
after the sniper retirement):

| collection | anon-public tabs it does NOT have |
|---|---|
| `ufc` | market · packs · pack-sniper · challenges · hot-floors · play |
| `disney-pinnacle` | sets · pack-sniper · challenges · hot-floors · play |
| `laliga-golazos` | pack-sniper · challenges · hot-floors · play |
| `nfl-all-day` | challenges · hot-floors · play |
| `nba-top-shot` | — (has all ten) |

**~19 URLs.** ⚠ None of them is in the sitemap (that derives from `pages ∩ PUBLIC_TAB_PAGES`,
so an absent tab is never advertised), which is what keeps this at medium rather than high:
Google has to find them by crawling links, not by being handed them.

## Why this is the soft-404 class and not a cosmetic issue

This repo has paid for soft-404s twice already and both are recorded: the entity-detail layout
gate (`app/(collections)/[collection]/edition/[slug]/layout.tsx` — a `loading.tsx` flushed the
shell so the page's `notFound()` committed a 200) and the `/moment/<edition uuid>` 301 that was
"fixed" in the page and turned out to be a 200 + `<meta refresh>`. Google treats a soft-404 as a
thin duplicate. The correct answer for a URL nobody advertises is arguable; for one that is
anon-public it is a status line.

## Why this was NOT shipped

The UFC sniper retirement (Trevor: *"get rid of the sniper section for ufc since there is no
market currently"*) needed exactly ONE of these redirected — `/ufc/sniper`, which unlike the
rest **was** in the sitemap and is indexed. Redirecting the other eighteen would:

1. change behaviour on **four collections nobody asked about**;
2. replace a deliberate UX shell (`FeatureTabGate` renders a branded "not available" card with a
   Back-to-Overview button) with a bounce the reader cannot see the reason for — that is a
   product call, not a cleanup;
3. widen a change to `proxy.ts`, the app's security wall, well past its brief.

⛔ **So `RETIRED_COLLECTION_TABS` holds one entry and its pin is deliberately ONE-WAY** — it
asserts no entry redirects a tab a collection actually ships (the way that list could do real
damage), and does NOT assert completeness. **A guard that claimed completeness here would be
lying**, and that is the failure mode this filing exists to prevent: someone reading the pin
later and concluding the class is handled.

## Suggested disposition

1. **A product call first, not code:** should a missing tab bounce to the overview, or keep the
   explanatory card? The card is better for a human who clicked a stale in-app link; the
   redirect is better for a crawler. **A 404 on the gate page would satisfy both** — same body,
   honest status — and is probably the answer, since `notFound()` in the layout (not the page)
   is the pattern this repo already proved for the entity routes.
2. If (1) lands, `FeatureTabGate` becomes the single place to fix, and `RETIRED_COLLECTION_TABS`
   can be deleted rather than grown.
3. ⚠ **Measure before assuming it matters:** none of these is in the sitemap, so check Search
   Console's "Soft 404" and "Crawled – not indexed" buckets for `/(ufc|disney-pinnacle|laliga-golazos|nfl-all-day)/(market|packs|play|challenges|hot-floors|pack-sniper|sets)` before spending on it.

## Also found in the same sweep (fixed, recorded so it is not re-filed)

- **`CollectionProfileClient`'s Tools grid linked to `/ufc/packs`** — a tab UFC has never had —
  for as long as that grid has shipped. It hardcoded four links instead of filtering the
  registry. Fixed in the sniper-retirement commit; the pin is in
  `__tests__/ufc-sniper-is-retired.test.ts`.
- **`FeatureTabGate`'s copy told readers to "use the Overview and Sniper tabs for live market
  state and deals"** — wrong when the missing tab IS the sniper, and a present-tense market
  claim on a collection whose market has closed. Fixed in the same commit.
