# DECISION — `rpc-panini-squeeze-v2`'s "not yet public" footer is WRONG and has been for 15 days: refresh it

Claude Code, interactive, 2026-08-16 16:00Z / 09:00 PT. Decision + exact wording, so the next
interactive Cowork session can execute without re-deriving. **I could not apply it myself** — the
artifact estate is Cowork-hosted and updated via Cowork's `update_artifact`; this Claude Code session
has no such tool, and the `Artifact` listing here is empty. Same for the staged
`outputs/candy-onboarding-v2.html`, which lives in the Cowork sandbox filesystem and has no
counterpart in this repo. **Both hand-offs were scoped correctly; only the decision is unblocked.**

## The measurement — one grep settles it

From [`lib/launch-flags.ts`](../../../lib/launch-flags.ts) and its two consumers, read live in the tree:

| check | value | consequence |
|---|---|---|
| `PANINI_PUBLIC` (line 66) | **`true`** | the flag flipped 2026-08-01 |
| `proxy.ts:288` | `if (!PANINI_PUBLIC && /^\/(?:insights\|api\/public\/insights\|api\/og\/insights)\/panini/…)` | the auth wall is **OFF** — anonymous visitors reach the board |
| `app/insights/panini-squeeze/layout.tsx:66` | `...(PANINI_PUBLIC ? {} : { robots: { index: false, follow: false } })` | **no `noindex`** — it is indexable |

`/insights/panini-squeeze` has been **public and indexable for 15 days**. A footer telling a reader
it is "not yet public" is not merely stale, it is **a false statement about the product's current
state**, sitting on an artifact whose purpose is to describe that product.

## ⚠ Do NOT replace it with a coverage percentage

The obvious rewrite — "public, covering N% of the catalogue" — reintroduces the exact defect
CLAUDE.md warns about twice. Panini discovery is **listing-gated**, so the coverage figure drifts
every time the runner walks (measured 47% at the 07-19 audit, **38.8%** on 08-02, and the
denominator keeps growing as new editions are discovered while the biased families do not re-bucket).
**Any hardcoded percentage in an artifact goes stale the same way this footer did** — and unlike the
board itself, an artifact has no live read to correct it. The surfaces already handle this correctly:
both `panini-squeeze/page.tsx` and `/api/public/insights/panini-squeeze` read
`panini_coverage_summary` **live** and hardcode nothing.

## Suggested replacement wording

> Live at **rippackscity.com/insights/panini-squeeze** — public since 2026-08-01.
> Coverage is **listing-gated**: an edition enters the index only once it has been listed, so the
> board is a **floor, not a census**. The live board states its own current coverage and refresh
> range; treat any figure quoted here as a snapshot.

Three properties that make it durable: it states the fact that changed (public), it **defers the
volatile number to the live surface** instead of copying it, and it carries the listing-gated
disclosure — which CLAUDE.md records as a **launch REQUIREMENT that travels with the surface**, not
an optional caveat.

## Durable

This is the same class the 08-16 session spent its day on, met from a third direction. A failed read
rendering as an answer, a filed fix outliving its premise, and **a claim that was TRUE WHEN WRITTEN
and was never re-checked** are all one failure: *something asserts a current fact it is no longer in
a position to know.* An artifact is the most exposed version, because unlike a board it has **no
live read that can correct it** — every fact in one is frozen at authoring time and must either be
re-verified on a schedule or written to defer to a surface that is.
