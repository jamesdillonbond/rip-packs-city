# Three anon-public tabs declare a canonical pointing at a URL that 302s Googlebot to /login

**Filed:** 2026-08-21 ~00:30Z (PT: 2026-08-20 17:30) · **Class:** SEO correctness. Measured, verified live.
**Status:** BLOCKED ON A DECISION, not on a diagnosis. Three fixes, materially different outcomes.

## The measurement

Found while shipping the sitemap feature-tab work (`1016d29f`). Of the 32 per-collection
feature tabs that pass `proxy.ts` `isPublicPath`, **four URLs** have no `PAGE_META` entry, so
they never call `pageMetadata()` and inherit `collectionLayoutMetadata()` instead:

| URL | anon? | emits |
|---|:--:|---|
| `/nba-top-shot/pack-sniper` | ✅ 200 | `canonical=/nba-top-shot` |
| `/nba-top-shot/challenges` | ✅ 200 | `canonical=/nba-top-shot` |
| `/nba-top-shot/hot-floors` | ✅ 200 | `canonical=/nba-top-shot` |
| `/nfl-all-day/pack-sniper` | ✅ 200 | `canonical=/nfl-all-day` |

**And the canonical target is auth-gated.** Verified live 2026-08-20 on the deployed tip:
`GET /nba-top-shot` returns **`x-matched-path: /login`** — `isPublicPath('/nba-top-shot','GET')`
is `false` for all five collection roots. So each of these four public pages tells Google
*"the canonical version of me is a page you will be redirected away from."*

Same root cause, second symptom: the inherited title renders the brand **twice** —
`NBA Top Shot Analytics — Rip Packs City | Rip Packs City` (the root template appends
` | Rip Packs City` to a string that already ends in it). That is deep-audit **D24**
recurring, on exactly the tabs that lack a layout.

## Why this is NOT simply "give them their own metadata"

That was my first conclusion and **the repo's own copy refutes it.** These three are the
**folded pages** of the 2026-07-18 IA reorg (`components/MobileNav.tsx`: *"the folded pages
(packs/pack-sniper/hot-floors/challenges) are filtered out per-collection via tabBarPages()
— Packs is reached through the Market/Sniper sub-toggle, Challenges through Play"*).

And `PAGE_META.play` already reads **"Play — {label} Challenges, Fast Break & Road to the
Ring"**. Promoting `/challenges` to a self-canonical indexable page would put it in direct
query competition with `/play`, which already claims that term — **cannibalisation, created
by the fix.** Same shape for `pack-sniper` vs `packs`, and `hot-floors` vs `market`.

⚠ So the CURRENT canonical is not nonsense: it encodes a real *consolidation* intent
("this folded sub-surface's equity belongs to its parent"). **The bug is the TARGET, not the
intent.** Folding is a NAVIGATION decision, though — `packs` is folded from the tab bar too
and has full SEO treatment and a sitemap entry — so "folded" does not by itself mean
"should not be indexed". That is the part I cannot settle from the code.

## The three options, and what separates them

1. **`robots: noindex, follow`** on the three layout-less tabs. Says what is true (folded
   sub-surfaces, not landing pages), keeps equity flowing, kills the broken signal, invents
   no copy, creates no cannibalisation. **Cost:** 4 public URLs permanently out of the index.
2. **Canonical → the public parent tab** (`challenges`→`play`, `pack-sniper`→`packs`,
   `hot-floors`→`market`; all three parents are anon-public, self-canonical and now
   sitemapped). Preserves the consolidation intent and is the *smallest* change from today's
   behaviour. **Cost:** ⚠ two of those three mappings are my INFERENCE — the MobileNav
   comment states only `challenges`→Play. Google also ignores a cross-page canonical when
   content differs materially, so this may be a no-op in practice.
3. **Give them `PAGE_META` + a layout** (self-canonical, real title, auto-enters the sitemap
   at 28→32). Consistent with all 7 sibling tabs. **Cost:** requires new copy AND accepts the
   cannibalisation above.

**Recommendation: (1).** It is the only one that needs neither invented copy nor an inferred
IA mapping, and it is honest about what these pages are. (3) is the one to pick if the
folded tabs are meant to rank on their own terms — that is a product call, not a code call.

## Not fixed here, deliberately

Nothing shipped for this. The canonical is a live SEO signal on public URLs and all three
options have materially different indexing outcomes, so it is a decision to make once rather
than a default to guess at. **The D24 doubled title rides along with whichever option wins**
(1 and 2 leave it; 3 removes it) — worth noting that its own blast radius is small: the five
`COLLECTION_LAYOUT_META` titles that carry it are otherwise rendered only on the auth-gated
collection roots, so signed-in users are the only ones who see the doubling there.

⚠ **Do not read "4 URLs" as the whole cost or as trivial.** It is 4 today because only
Top Shot ships all three folded tabs and All Day ships one. The count grows with any
collection that adds them, and the defect is per-TAB, not per-URL — a fifth folded tab
inherits it automatically.
